/*! Terminal 7
 *  This file contains the code that makes terminal 7 - a webrtc based
 *  touchable terminal multiplexer.
 *
 *  Copyright: (c) 2020 Benny A. Daon - benny@tuzig.com
 *  License: GPLv3
 */
import { Gate } from './gate.js'
import { Window } from './window.js'
import { CyclicArray } from './cyclic.js'
import * as Hammer from 'hammerjs'
import * as TOML from '@iarna/toml'
import * as imageMapResizer from './imageMapResizer.js'
import CodeMirror from 'codemirror/src/codemirror.js'
import { vimMode } from 'codemirror/keymap/vim.js'
import { tomlMode} from 'codemirror/mode/toml/toml.js'
import { dialogAddOn } from 'codemirror/addon/dialog/dialog.js'
import { formatDate } from './utils.js'
import '@capacitor-community/http'

import { Plugins, FilesystemDirectory } from '@capacitor/core'
import { openDB } from 'idb'

const { App, BackgroundTask, Clipboard, Device, Http, Network, Storage,
        Filesystem } = Plugins
var PBPending = []

const DEFAULT_DOTFILE = `[theme]
foreground = "#00FAFA"
background = "#000"
selection = "#D9F505"

[indicators]
flash = 100

[exec]
shell = "bash"

[net]
timeout = 3000
retries = 3
ice_server = "stun:stun2.l.google.com:19302"
peerbook = "pb.terminal7.dev"

[ui]
quickest_press = 1000
max_tabs = 3
cut_min_distance = 80
cut_min_speed = 2.5
# no pinch when scrolling -> y velocity higher than XTZ px/ms
pinch_max_y_velocity = 0.1
`

export class Terminal7 {
    /*
     * Terminal7 constructor, all properties should be initiated here
     */
    constructor(settings) {
        settings = settings || {}
        this.gates = []
        this.cells = []
        this.timeouts = []
        this.activeG = null
        window.terminal7 = this
        this.scrollLingers4     = settings.scrollLingers4 || 2000
        this.shortestLongPress  = settings.shortestLongPress || 1000
        this.borderHotSpotSize  = settings.borderHotSpotSize || 30
        this.certificates = null
        this.confEditor = null
        this.flashTimer = null
        this.netStatus = null
        this.ws = null
        this.pbSendTask = null
        this.logBuffer = CyclicArray(settings.logLines || 101)
        this.zoomedE = null
    }
    /*
     * Terminal7.open opens terminal on the given DOM element,
     * loads the gates from local storage and redirects to home
     */
    async open() {
        let e = document.getElementById('terminal7')
        this.log("in open")
        this.e = e
        // reading conf
        let d = {},
            { value } = await Storage.get({key: 'dotfile'})
        if (value == null) {
            value = DEFAULT_DOTFILE
            Storage.set({key: 'dotfile', value: value})
        }
        try {
            d = TOML.parse(value)
        } catch(err) {
            d = TOML.parse(DEFAULT_DOTFILE)
            terminal7.run(_ =>
                this.notify(
                    `Using default conf as parsing the dotfile failed:<br>${err}`, 
                10))
        }
        this.loadConf(d)

        // buttons
        document.getElementById("trash-button")
                .addEventListener("click",
                    ev =>  {
                        if (this.activeG)
                            this.activeG.activeW.activeP.close()})
        document.getElementById("home-button")
                .addEventListener("click", ev => this.goHome())
        document.getElementById("log-button")
                .addEventListener("click", ev => this.logDisplay())
        document.getElementById("search-button")
                .addEventListener("click", ev => 
                    this.activeG && this.activeG.activeW.activeP.toggleSearch())
        document.getElementById("help-gate")
                .addEventListener("click", ev => this.toggleHelp())
        document.getElementById("help-button")
                .addEventListener("click", ev => this.toggleHelp())
        document.getElementById("refresh")
                .addEventListener("click", ev => this.pbVerify())
        let addHost = document.getElementById("add-host")
        document.getElementById('plus-host').addEventListener(
            'click', ev => {
                this.logDisplay(false)
                addHost.querySelector("form").reset()
                addHost.classList.remove("hidden")
            })
        addHost.querySelector("form").addEventListener('submit', (ev) => {
            ev.preventDefault()
            let remember = addHost.querySelector('[name="remember"]').checked,
                gate = this.addGate({
                    addr: addHost.querySelector('[name="hostaddr"]').value,
                    name: addHost.querySelector('[name="hostname"]').value,
                    store: remember
                })
            if (remember)
                this.storeGates()
            if (typeof gate == "string")
                this.notify(gate)
            else {
                this.clear()
                gate.connect()
            }
        })
        // hide the modal on xmark click
        addHost.querySelector(".close").addEventListener('click',  ev =>  {
            this.clear()
        })
        // Handle network events for the indicator
        Network.getStatus().then(s => this.updateNetworkStatus(s))
        Network.addListener('networkStatusChange', s => 
            this.updateNetworkStatus(s))
        this.catchFingers()
        // setting up edit host events
        let editHost = document.getElementById("edit-host")
        editHost.querySelector("form").addEventListener('submit', ev => {
            ev.preventDefault()
            editHost.gate.editSubmit(ev)
        })
        editHost.querySelector(".close").addEventListener('click',  ev =>
            terminal7.clear())
        editHost.querySelector(".trash").addEventListener('click',  ev => {
            editHost.gate.delete()
            terminal7.clear()
        })
        editHost.querySelector(".reset").addEventListener('click',  ev => {
            this.clear()
            editHost.gate.showResetHost(ev)
        })
        // setting up reset host event
        let resetHost = document.getElementById("reset-host")
        resetHost.querySelector("form").addEventListener('submit', ev => {
            ev.preventDefault()
            editHost.gate.restartServer()
        })
        resetHost.querySelector(".close").addEventListener('click',  ev =>
            ev.target.parentNode.parentNode.parentNode.classList.add("hidden"))
        // setting up reset cert events
        let resetCert = document.getElementById("reset-cert")
        resetCert.querySelector(".reset").addEventListener('click',  ev => {
            openDB("t7", 1).then(db => {
                let tx = db.transaction("certificates", "readwrite"),
                    store = tx.objectStore("certificates")
                store.clear().then(_ => 
                    this.generateCertificate().then(
                        _ => this.storeCertificate().then(
                                _ => this.pbVerify())))
                .catch(e => terminal7.log(e))
            })
            ev.target.parentNode.parentNode.classList.add("hidden")

        })
        resetCert.querySelector(".close").addEventListener('click',  ev =>
            ev.target.parentNode.parentNode.parentNode.classList.add("hidden"))
        this.goHome()
        document.addEventListener("keydown", ev => {
            if (ev.key == "Meta") {
                this.metaPressStart = Date.now()
                this.run(_ => {
                    let e = document.getElementById('keys-help')
                    if (!this.conf.features["copy_mode"])
                        e.querySelectorAll('.copy_mode').forEach(i =>
                            i.style.display = "none")
                    if (Date.now() - this.metaPressStart > 987)
                        e.classList.remove('hidden')
                }, terminal7.conf.ui.quickest_press)
            } else
                this.metaPressStart = Number.MAX_VALUE
        })
        document.addEventListener("keyup", ev => {
            // hide the keys help when releasing any key
            document.getElementById('keys-help').classList.add('hidden')
            this.metaPressStart = Number.MAX_VALUE
        })
        // Load gates from local storage
        let gates
        value = (await Storage.get({key: 'gates'})).value
        this.log("read: ", value)
        if (value) {
            try {
                gates = JSON.parse(value)
            } catch(e) {
                 terminal7.log("failed to parse gates", value, e)
                gates = []
            }
            gates.forEach((g) => {
                g.store = true
                this.addGate(g).e.classList.add("hidden")
            })
        }
        // window.setInterval(_ => this.periodic(), 2000)
        App.addListener('appStateChange', state => {
            if (!state.isActive) {
                // We're getting suspended. disengage.
                let taskId = BackgroundTask.beforeExit(async () => {
                    terminal7.log("Benched. Disengaging from all gates")
                    this.disengage(() => {
                        terminal7.log("finished disengaging")
                        this.clearTimeouts()
                        BackgroundTask.finish({taskId})
                    })
                })
            }
            else {
                // We're back! ensure we have the latest network status and 
                // reconnect to the active gate
                terminal7.log("Active ☀️")
                this.clearTimeouts()
                Network.getStatus().then(s => this.updateNetworkStatus(s))
            }
        })
        document.getElementById("log").addEventListener("click",
            _ => this.logDisplay(false))

        // settings button and modal
        var modal   = document.getElementById("settings-modal")
        document.getElementById("dotfile-button")
                .addEventListener("click", ev => this.toggleSettings(ev))
        modal.querySelector(".close").addEventListener('click',
            ev => {
                document.getElementById("dotfile-button").classList.remove("on")
                this.clear()
            }
        )
        modal.querySelector(".save").addEventListener('click',
            ev => this.wqConf())
        modal.querySelector(".copy").addEventListener('click',
            ev => {
                var area = document.getElementById("edit-conf")
                this.confEditor.save()
                Clipboard.write({string: area.value})
                this.clear()
            })
        // peerbook button and modal
        modal = document.getElementById("peerbook-modal")
        modal.querySelector(".close").addEventListener('click',
            ev => this.clear() )
        modal.querySelector(".save").addEventListener('click',
            ev => {
                this.setPeerbook()
                this.clear()
            })
        // get the fingerprint and connect to peerbook
        this.getFingerprint().then(_ => {
            if (this.certificates.length > 0) 
                this.pbVerify()
            else {
                this.generateCertificate().then(_ => {
                    this.storeCertificate().then(_ => {
                        this.pbVerify()
                    })
                })
            }
        })
        var invited = await Storage.get({key: 'invitedToPeerbook2'})
        if (invited.value == null) {
            modal = document.getElementById("peerbook-modal")
            modal.querySelector('[name="peername"]').value =
                this.conf.peerbook.peer_name
            modal.classList.remove("hidden")
            Storage.set({key: 'invitedToPeerbook2', value: 'indeed'})
        }
        // Last one: focus
        this.focus()
    }
    async setPeerbook() {
        var e   = document.getElementById("peerbook-modal"),
            dotfile = (await Storage.get({key: 'dotfile'})).value || DEFAULT_DOTFILE,
            email = e.querySelector('[name="email"]').value,
            peername = e.querySelector('[name="peername"]').value
        if (email == "")
            return
        dotfile += `
[peerbook]
email = "${email}"
peer_name = "${peername}"\n`

        Storage.set({key: "dotfile", value: dotfile})
        this.loadConf(TOML.parse(dotfile))
        e.classList.add("hidden")
        this.notify("Your email was added to the dotfile")
    }
    pbVerify() {
        var email = this.conf.peerbook.email,
            host = this.conf.net.peerbook

        if (typeof host != "string" || typeof email != "string")
            return

        this.getFingerprint().then(fp => {
            fetch(`https://${host}/verify`,  {
                headers: {"Content-Type": "application/json"},
                method: 'POST',
                body: JSON.stringify({kind: "terminal7",
                    name: this.conf.peerbook.peer_name,
                    email: email,
                    fp: fp
                })
            }).then(response => {
                if (response.ok)
                    return response.json()
                if (response.status == 409) {
                    var e = document.getElementById("reset-cert"),
                        pbe = document.getElementById("reset-cert-error")
                    pbe.innerHTML = response.data 
                    e.classList.remove("hidden")
                }
                throw new Error(`verification failed: ${response.data}`)
            }).then(m => this.onPBMessage(m))
        })
    }
    async toggleSettings(ev) {
        var modal   = document.getElementById("settings-modal"),
            button  = document.getElementById("dotfile-button"),
            area    =  document.getElementById("edit-conf"),
            conf    =  (await Storage.get({key: "dotfile"})).value || DEFAULT_DOTFILE

        area.value = conf

        button.classList.toggle("on")
        modal.classList.toggle("hidden")
        if (button.classList.contains("on")) {
           if (this.confEditor == null) {
                vimMode(CodeMirror)
                tomlMode(CodeMirror)
                dialogAddOn(CodeMirror)
                CodeMirror.commands.save = () => this.wqConf()

                this.confEditor  = CodeMirror.fromTextArea(area, {
                   value: conf,
                   lineNumbers: true,
                   mode: "toml",
                   keyMap: "vim",
                   matchBrackets: true,
                   showCursorWhenSelecting: true
                })
            }
            this.confEditor.focus()
        }

    }
    /*
     * wqConf saves the configuration and closes the conf editor
     */
    wqConf() {
        var area    =  document.getElementById("edit-conf")
        document.getElementById("dotfile-button").classList.remove("on")
        this.confEditor.save()
        this.loadConf(TOML.parse(area.value))
        Storage.set({key: "dotfile", value: area.value})
        this.cells.forEach(c => {
            if (typeof(c.setTheme) == "function")
                c.setTheme(this.conf.theme)
        })
        document.getElementById("settings-modal").classList.add("hidden")
        this.confEditor.toTextArea()
        this.confEditor = null
        this.pbVerify()

    }
    /*
     * terminal7.onTouch is called on all browser's touch events
     */
    onTouch(type, ev) {
        let e = ev.target,
            pane = e.p,
            nameB = e.gate && e.gate.nameE.parentNode.parentNode
        if (type == "start") {
            this.touch0 = Date.now() 
            this.firstT = this.lastT = ev.changedTouches
            if (e.gate instanceof Gate)
                nameB.classList.add("pressed")
            if (e.w instanceof Window)
                e.classList.add("pressed")
            return 
        } 
        if ((type == "cancel") || (ev.changedTouches.length != 1)) {
            this.touch0 = null
            this.firstT = []
            this.lastT = []
            this.gesture = null
            if (e.gate instanceof Gate)
                nameB.classList.remove("pressed")
            return
        }

        if (this.firstT.length == 0)
            return

        let x  = ev.changedTouches[0].pageX,
            y  = ev.changedTouches[0].pageY,
            dx = this.firstT[0].pageX - x,
            dy = this.firstT[0].pageY - y,
            d  = Math.sqrt(Math.pow(dx, 2) + Math.pow(dy, 2)),
            deltaT = Date.now() - this.touch0,
            s  = d/deltaT,
            r = Math.abs(dx / dy),
            topb  = r < 1.0


        if (e.gate instanceof Gate) {
            let longPress = terminal7.conf.ui.quickest_press
            if (deltaT > longPress) {
                nameB.classList.remove("pressed")
                e.gate.edit()
            }
            if (type == 'end')
                nameB.classList.remove("pressed")
            return
        }
        if (e.w instanceof Window) {
            let longPress = terminal7.conf.ui.quickest_press
            if (deltaT > longPress) {
                e.classList.remove("pressed")
                e.w.rename()
                return
            }
            if (type == 'end') {
                e.classList.remove("pressed")
                e.w.gate.breadcrumbs.push(e.w)
                e.w.focus()
            }
            return
        }

        if (pane === undefined)  {
            return
        }
        let lx = (x / document.body.offsetWidth - pane.xoff) / pane.sx,
            ly = (y / document.body.offsetHeight - pane.yoff) / pane.sy
        if (type == "move") {
            if (this.gesture == null) {
                let rect = pane.e.getBoundingClientRect()
                this.log(x, y, rect)
                // identify pan event on a border
                if (Math.abs(rect.x - x) < this.borderHotSpotSize)
                    this.gesture = "panborderleft"
                else if (Math.abs(rect.right - x) < this.borderHotSpotSize) 
                    this.gesture = "panborderright"
                else if (Math.abs(y - rect.y) < this.borderHotSpotSize)
                    this.gesture = "panbordertop"
                else if (Math.abs(y - rect.bottom) < this.borderHotSpotSize)
                    this.gesture = "panborderbottom"
                else 
                    return
                this.log(`identified: ${this.gesture}`)
            } 
            if (this.gesture.startsWith("panborder")) {
                let where = this.gesture.slice(9),
                    dest = ((where == "top") || (where == "bottom"))
                            ? y / document.body.offsetHeight
                            : x / document.body.offsetWidth
                if (dest > 1.0)
                    dest = 1.0
                this.log(`moving ${where} border of #${pane.id} to ${dest}`)
                pane.layout.moveBorder(pane, where, dest)
            }
            this.lastT = ev.changedTouches
        }
        if (type == "end") {
            if ((ev.changedTouches.length == 1)
                && (d > this.conf.ui.cutMinDistance)
                && (s > this.conf.ui.cutMinSpeed)) {
                    // it's a cut!!
                    let p = ev.target.p
                    if (!pane.zoomed)  {
                        let t = pane.split((topb)?"topbottom":"rightleft",
                                           (topb)?lx:ly)
                        // t.focus()
                    }
                }
            this.touch0 = null
            this.firstT = []
            this.gesture = null
        }
    }
    catchFingers() {
        var start,
            last,
            firstT = [],
            gesture = null
        this.e.addEventListener("touchstart", ev =>
            this.onTouch("start", ev), false)
        this.e.addEventListener("touchend", ev =>
            this.onTouch("end", ev), false)
        this.e.addEventListener("touchcancel", ev =>
            this.onTouch("cancel", ev), false)
        this.e.addEventListener("touchmove", ev =>
            this.onTouch("move", ev), false)
    }
    /*
     * Terminal7.a.ddGate is used to add a gate to a host.
     * the function ensures the gate has a unique name adds the gate to
     * the `gates` property, stores and returns it.
     */
    addGate(props) {
        let out = [],
            p = props || {},
            addr = p.addr,
            nameFound = false
        // add the id
        p.id = this.gates.length
        p.verified = false

        // if no port specify, use the default port
        if (addr && (addr.indexOf(":") == -1))
            p.addr = `${addr}:7777`

        this.gates.forEach(i => {
            if (props.name == i.name) {
                i.online = props.online
                nameFound = true
            }
        })
        if (nameFound) {
            return "Gate name is not unique"
        }

        let g = new Gate(p)
        this.gates.push(g)
        g.open(this.e)
        return g
    }
    async storeGates() { 
        let out = []
        this.gates.forEach((h) => {
            if (h.store) {
                let ws = []
                h.windows.forEach((w) => ws.push(w.id))
                out.push({id: h.id, addr: h.addr, user: h.user, secret: h.secret,
                    name:h.name, windows: ws, store: true})
            }
        })
        this.log("Storing gates:", out)
        await Storage.set({key: 'gates', value: JSON.stringify(out)})
    }
    clear() {
        this.e.querySelectorAll('.temporal').forEach(e => e.remove())
        this.e.querySelectorAll('.modal').forEach(e => {
            if (!e.classList.contains("non-clearable"))
                e.classList.add("hidden")
        })
        this.focus()
    }
    goHome() {
        let s = document.getElementById('home-button'),
            h = document.getElementById('home'),
            hc = document.getElementById('downstream-indicator')
        s.classList.add('on')
        hc.classList.add('off')
        hc.classList.remove('on', 'failed')
        if (this.activeG) {
            this.activeG.e.classList.add("hidden")
            this.activeG = null
        }
        // hide the modals
        this.clear()
        // trash and search are off
        document.getElementById("search-button").classList.add("off")
        document.getElementById("trash-button").classList.add("off")
        window.location.href = "#home"
    }
    /* 
     * Terminal7.logDisplay display or hides the notifications.
     * if the parameters in udefined the function toggles the displays
     */
    logDisplay(show) {
        let e = document.getElementById("log")
        if (show === undefined)
            // if show is undefined toggle current state
            show = !e.classList.contains("show")
        if (show) {
            e.classList.add("show")
            document.getElementById("log-button")
                .classList.add("on")
        } else {
            e.classList.remove("show")
            document.getElementById("log-button")
                .classList.remove("on")
        }
        this.focus()
    }
    /*
     * OnMessage is called by the pane when they recieve traffic.
     * if the indicator is not alreay flushing it will flush it
     */
    onMessage(m) {
        if (this.flashTimer == null) {
            let  e = document.getElementById("downstream-indicator"),
                 flashTime = this.conf.indicators && this.conf.indicators.flash
                             || 88
            e.classList.remove("failed", "off")
            e.classList.add("on")
            this.flashTimer = terminal7.run(_ => {
                this.flashTimer = null
                e.classList.remove("on")
                e.classList.add("off")
            }, flashTime) 
        }
    }
    /*
     * onDisconnect is called when a gate disconnects.
     */
    onDisconnect(gate) {
        if (gate != this.activeG)
            return
        let e = document.getElementById("disconnect-template")
        e = e.content.cloneNode(true)
        this.clear()
        // clear pending messages to let the user start fresh
        this.pendingCDCMsgs = []
        e.querySelector("h1").textContent =
            `${gate.name} communication failure`
        e.querySelector("form").addEventListener('submit', ev => {
            this.clear()
            gate.boarding = false
            gate.clear()
            gate.connect()
        })
        e.querySelector(".close").addEventListener('click', ev => {
            terminal7.goHome()
        })
        this.e.appendChild(e)
    }
    /*
     * focus restores the focus to the ative pane, if there is one
     */
    focus() {
        if (this.activeG && this.activeG.activeW &&
            this.activeG.activeW.activeP)
            this.activeG.activeW.activeP.focus()
        else
            this.e.focus()
    }
    ssh(e, gate, cmd, cb) {
        let uname = e.querySelector('[name="uname"]').value,
            pass = e.querySelector('[name="pass"]').value,
            addr = gate.addr.substr(0, gate.addr.indexOf(":"))
        this.notify("ssh is connecting...")
        window.cordova.plugins.sshConnect.connect(uname, pass, addr, 22,
            resp => {
                this.notify("ssh connected")
                if (resp) {
                    // TODO: make it work with non-standrad webexec locations
                    window.cordova.plugins.sshConnect.executeCommand(
                        cmd, 
                        msg =>  {
                            this.notify("ssh executed command success")
                            if (typeof cb === "function")
                                cb(msg)
                        },
                        msg => this.notify(`ssh failed: ${msg}`))
                    window.cordova.plugins.sshConnect.disconnect()
                }
            }, ev => {
                if (ev == "Connection failed. Could not connect")
                    if (gate.verified)
                        this.notify(ev)
                    else
                        this.notify(`Failed the connect. Maybe ${gate.addr} is wrong`)
                else
                    this.notify("Wrong password")
                this.log("ssh failed to connect", ev)
            })
    }
    onNoSignal(gate) {
        let e = document.getElementById("nosignal-template")
        e = e.content.cloneNode(true)
        this.clear()
        // clear pending messages to let the user start fresh
        this.pendingCDCMsgs = []
        e.querySelectorAll(".name").forEach(e => e.textContent = gate.name)
        e.querySelectorAll(".address").forEach(e => e.textContent = gate.addr)
        e.querySelector(".edit-link").addEventListener('click', _ => {
            this.clear()
            gate.edit()
        })
        e.querySelector("form").addEventListener('submit', ev => {
            ev.preventDefault()
            this.ssh(this.e.lastElementChild, gate, 
                "webexec start", ev => {
                gate.clear()
                this.clear()
                terminal7.run(_ => gate.connect(), 2000)
            })
        })
        e.querySelector(".close").addEventListener('click', ev => {
            gate.disengage()
            gate.clear()
            terminal7.goHome()
        })
        e.querySelector(".reconnect").addEventListener('click', ev => {
            this.clear()
            gate.clear()
            gate.connect()
        })
        this.e.appendChild(e)
    }
    /*
     * noitify adds a message to the teminal7 notice board
     */
    notify(message) {    
        let ul = document.getElementById("log-msgs"),
            li = document.createElement("li"),
            d = new Date(),
            t = formatDate(d, "HH:mm:ss.fff")

        let lines = ul.querySelectorAll('li')
        li.innerHTML = `<time>${t}</time><p>${message}</p>`
        li.classList = "log-msg"
        ul.appendChild(li)
        terminal7.logDisplay(true)
    }
    run(cb, delay) {
        var i = this.timeouts.length,
            r = window.setTimeout(ev => {
                this.timeouts.splice(i, 1)
                cb(ev)
            }, delay)
        this.timeouts.push(r)
        return r
    }
    clearTimeouts() {
        this.timeouts.forEach(t => window.clearTimeout(t))
        this.timeouts = []
        this.gates.forEach(g => g.updateID = null)
    }
    periodic() {
        var now = new Date()
        this.gates.forEach(g => {
            if (g.periodic instanceof Function) 
                g.periodic(now)
        })
    }
    /*
     * disengage gets each active gate to disengae
     */
    disengage(cb) {
        var count = 0
        this.gates.forEach(g => {
            if (g.boarding) {
                count++
                g.disengage(_ => count--)
            }
        })
        let callCB = () => terminal7.run(() => {
            if (count == 0)
                cb()
             else 
                callCB()
        }, 10)
        if (this.ws != null) {
            this.ws.onopen = undefined
            this.ws.onmessage = undefined
            this.ws.onerror = undefined
            this.ws.onclose = undefined
            this.ws.close()
            this.ws = null
        }
        callCB()
    }
    updateNetworkStatus (status) {
        let cl = document.getElementById("connectivity").classList,
            offl = document.getElementById("offline").classList
        this.netStatus = status
        this.log(`updateNetwrokStatus: ${status.connected}`)
        if (status.connected) {
            cl.remove("failed")
            offl.add("hidden")
            if (this.activeG)
                this.activeG.connect()
            else 
                this.pbVerify()
        }
        else {
            offl.remove("hidden")
            cl.add("failed")
            this.gates.forEach(g => g.stopBoarding())
        }
    }
    loadConf(conf) {
        this.conf = conf
        this.conf.features = this.conf.features || {}
        this.conf.ui = this.conf.ui || {}
        this.conf.net = this.conf.net || {}
        this.conf.ui.quickest_press = this.conf.ui.quickest_press || 1000
        this.conf.ui.max_tabs = this.conf.ui.max_tabs || 3
        this.conf.ui.cutMinSpeed = this.conf.ui.cut_min_speed || 2.2
        this.conf.ui.cutMinDistance = this.conf.ui.cut_min_distance || 50
        this.conf.ui.pinchMaxYVelocity = this.conf.ui.pinch_max_y_velocity || 0.1
        this.conf.net.iceServer = this.conf.net.ice_server ||
            "stun:stun2.l.google.com:19302"
        this.conf.net.peerbook = this.conf.net.peerbook ||
            "pb.terminal7.dev"
        this.conf.net.timeout = this.conf.net.timeout || 3000
        this.conf.net.retries = this.conf.net.retries || 3
        if (!this.conf.peerbook) this.conf.peerbook = {}
        if (!this.conf.peerbook.peer_name)
            Device.getInfo().then(i =>
                this.conf.peerbook.peer_name = `${i.name}'s ${i.model}`)
    }
    // gets the will formatted fingerprint from the current certificate
    getFingerprint() {
        // gets the certificate from indexDB. If they are not there, create them
        return new Promise(resolve => {
            if (this.certificates) {
                var cert = this.certificates[0].getFingerprints()[0]
                resolve(cert.value.toUpperCase().replaceAll(":", ""))
            }
            openDB("t7", 1, { 
                    upgrade(db) {
                        db.createObjectStore('certificates', {keyPath: 'id',
                            autoIncrement: true})
                    },
            }).then(db => {
                let tx = db.transaction("certificates"),
                    store = tx.objectStore("certificates")
                 store.getAll().then(certificates => {
                    this.certificates = certificates
                    db.close()
                    var cert = certificates[0].getFingerprints()[0]
                    resolve(cert.value.toUpperCase().replaceAll(":", ""))
                 }).catch(e => {
                    this.log(`got a db error getting the fp: ${e}`)
                    resolve(e)
                })
            }).catch(e => {
                db.close()
                this.log(`got an error opening db ${e}`)
                resolve(e)
            })
        })
    }
    generateCertificate() {
        return new Promise(resolve=> {
            RTCPeerConnection.generateCertificate({
              name: "ECDSA",
              namedCurve: "P-256",
              expires: 31536000000
            }).then(cert => {
                this.log("Generated cert", cert)
                this.certificates = [cert]
                resolve(this.certificates)
            }).catch(e => {
                this.log(`failed generating cert ${e}`)
                resolve(null)
            })
        })
    }
    storeCertificate() {
        return new Promise(resolve=> {
            openDB("t7", 1, { 
                    upgrade(db) {
                        db.createObjectStore('certificates', {keyPath: 'id',
                            autoIncrement: true})
                    },
            }).then(db => {
                let tx = db.transaction("certificates", "readwrite"),
                    store = tx.objectStore("certificates"),
                    c = this.certificates[0]
                c.id = 1
                store.add(c).then(_ => {
                    db.close()
                    resolve(this.certificates[0]).catch(e => {
                        this.log(`got an error storing cert ${e}`)
                        resolve(null)
                    })
                })
            }).catch(e => {
                this.log (`got error from open db ${e}`)
                db.close()
                resolve(null)
            })
        })
    }
    toggleHelp() {
        // TODO: add help for home
        // var helpId = (this.activeG)? "help-gate":"help-home",
        var helpId = "help-gate",
            ecl = document.getElementById(helpId).classList,
            bcl = document.getElementById("help-button").classList
            
        ecl.toggle("show")
        bcl.toggle("on")
        if (ecl.contains("show"))
            imageMapResizer()
        else
            this.focus()
        // TODO: When at home remove the "on" from the home butto
    }
    pbSend(m) {
        // null message are used to trigger connection, ignore them
        if (m != null) {
            if (this.ws != null && this.ws.readyState == WebSocket.OPEN) {
                this.log("sending to pb:", m)
                this.ws.send(JSON.stringify(m))
                return
            }
            PBPending.push(m)
        }
        this.wsConnect()
    }
    wsConnect() {
        var email = this.conf.peerbook.email
        if ((this.ws != null) || ( typeof email != "string")) return
        this.getFingerprint().then(fp => {
            var host = this.conf.net.peerbook,
                name = this.conf.peerbook.peer_name,
                url = encodeURI(`wss://${host}/ws?fp=${fp}&name=${name}&kind=terminal7&email=${email}`),
                ws = new WebSocket(url)
            this.ws = ws
            ws.onmessage = ev => {
                var m = JSON.parse(ev.data)
                this.log("got ws message", m)
                this.onPBMessage(m)
            }
            ws.onerror = ev => {
                // TODO: Add some info avour the error
                this.notify("\uD83D\uDCD6 WebSocket Error")
            }
            ws.onclose = ev => {
                ws.onclose = undefined
                ws.onerror = undefined
                ws.onmessage = undefined
                this.ws = null

            }
            ws.onopen = ev => {
                this.log("on open ws", ev)
                if (this.pbSendTask == null)
                    this.pbSendTask = this.run(_ => {
                        PBPending.forEach(m => {
                            this.log("sending ", m)
                            this.ws.send(JSON.stringify(m))})
                        this.pbSendTask = null
                        PBPending = []
                    }, 10)
            }
        })
    }
    onPBMessage(m) {
        if (m["code"] !== undefined) {
            this.notify(`\uD83D\uDCD6 ${m["text"]}`)
            return
        }
        if (m["peers"] !== undefined) {
            this.notify("\uD83D\uDCD6 Got a fresh server list")
            m["peers"].forEach(p => {
                if ((p.kind == "webexec") && p.verified) 
                    this.addGate(p)
            })
            return
        }
        if (m["verified"] !== undefined) {
            if (!m["verified"])
                this.notify("\uD83D\uDCD6 UNVERIFIED. Please check you email.")
            return
        }
        var g = this.gates.find(g => g.fp == m.source_fp)
        if (typeof g != "object") {
            this.log("received bad gate", m)
            return
        }
        if (m.candidate !== undefined) {
            g.pc.addIceCandidate(m.candidate).catch(e =>
                g.notify(`ICE candidate error: ${e}`))
            return
        }
        if (m.answer !== undefined ) {
            var answer = JSON.parse(atob(m.answer))
            g.peerConnect(answer)
            return
        }
        if (m.peer_update !== undefined) {
            g.online = m.peer_update.online
            return
        }
    }
    log (...args) {
        var line = ""
        args.forEach(a => line += JSON.stringify(a) + " ")
        console.log(line)
        this.logBuffer.push(line)
    }
    async dumpLog() {
        var data = "",
            suffix = new Date().toISOString().replace(/[^0-9]/g,""),
            path = `terminal7_${suffix}.log`
        while (this.logBuffer.length > 0) {
            data += this.logBuffer.shift() + "\n"
        }
        Clipboard.write({string: data})
        this.notify("Log copied to clipboard")
        /* TODO: wwould be nice to store log to file, problme is 
         * Storage pluging failes
        try { 
            await Filesystem.writeFile({
                path: path,
                data: data,
                directory: FilesystemDirectory.Documents
            })i
        } catch(e) { 
            terminal7.log(e)
        }
        */
    }
}


import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, query, orderBy, limit, doc, setDoc, getDoc, onSnapshot, updateDoc, where, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";

// --- 1. CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyAYFnSTEBqUQZ107GC_7LxflOJs3uygbdQ",
    authDomain: "jessmath-83399.firebaseapp.com",
    projectId: "jessmath-83399",
    storageBucket: "jessmath-83399.firebasestorage.app",
    messagingSenderId: "745035908096",
    appId: "1:745035908096:web:aed7c4ffe9637e923704e5",
    measurementId: "G-QHN9HSRZ6K"
};


// 1. INITIATE CALL (WITH BROWSER SECURITY CHECK & TIMEOUT)
window.initiateVoiceCall = function() {
    console.log("Calling Target UID:", currentChatUserId);
    if(!currentChatUserId) return alert("SYSTEM ERROR: Open a chat with an agent first.");
    if(!socket || !socket.connected) return alert("SYSTEM ERROR: Cannot connect to comms server.");
    
    // 🔴 SECURITY CHECK: Bawal mag-call kung nakaharang ang Microphone sa browser!
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("MIC BLOCKED: Voice Comms requires a secure connection (HTTPS or Localhost).");
        return;
    }

    if(window.Sound) window.Sound.click();
    document.getElementById("chat-target-name").innerText = "CALLING...";
    
    // Ipadala ang signal sa Server
    socket.emit('request_voice_call', {
        targetUid: currentChatUserId,
        callerName: currentUser.username || myName,
        callerUid: currentUser.uid
    });

    // 🟢 FAILSAFE TIMEOUT: Kung walang sumagot o nag-error ang server sa loob ng 15 seconds
    if(window.callTimeout) clearTimeout(window.callTimeout);
    window.callTimeout = setTimeout(() => {
        const chatName = document.getElementById("chat-target-name");
        if (chatName && chatName.innerText === "CALLING...") {
            chatName.innerText = "NO ANSWER";
            if(window.Sound) window.Sound.error();
            
            // Ibalik sa pangalan ng player pagkatapos ng 3 seconds
            setTimeout(() => {
                const friend = currentUser.friends.find(f => f.uid === currentChatUserId);
                if (chatName) chatName.innerText = friend ? friend.name : "AGENT";
            }, 3000);
        }
    }, 15000);
};

// 4. WEBRTC ENGINE (WITH ERROR CATCHER)
async function setupWebRTC(isCaller) {
    try {
        console.log("🎙️ Requesting Microphone Access...");
        
        // 🔴 Double check kung supported ng browser bago mag-request
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("Browser blocked microphone access. Needs HTTPS/localhost.");
        }

        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        peerConnection = new RTCPeerConnection(rtcConfig);
        
        localStream.getTracks().forEach(track => { peerConnection.addTrack(track, localStream); });

        peerConnection.ontrack = (event) => {
            console.log("🔊 Connecting Remote Audio Stream!");
            let remoteAudio = document.getElementById('remote-audio');
            if(!remoteAudio) {
                remoteAudio = document.createElement('audio');
                remoteAudio.id = 'remote-audio';
                remoteAudio.autoplay = true;
                document.body.appendChild(remoteAudio);
            }
            remoteAudio.srcObject = event.streams[0];
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc_ice_candidate', { targetSocket: currentCallTargetSocket, candidate: event.candidate });
            }
        };

        if (isCaller) {
            console.log("📤 Creating Offer...");
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('webrtc_offer', { targetSocket: currentCallTargetSocket, offer: offer });
        }
    } catch (e) {
        console.error("Mic Access Denied or WebRTC Error:", e);
        alert("SYSTEM ALERT: Microphone access is denied. Check browser permissions or ensure you are on HTTPS/Localhost.");
        window.endVoiceCall(); // I-cancel ang buong call process
    }
}
// ==========================================
// 📺 FULLSCREEN CONTROLLER
// ==========================================
window.toggleFullScreen = function() {
    if(window.Sound && window.Sound.click) window.Sound.click();
    
    const btn = document.getElementById('fullscreen-btn');
    
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().then(() => {
            if(btn) btn.innerText = ">< EXIT FULLSCREEN";
        }).catch(err => {
            console.log(`Error attempting to enable fullscreen: ${err.message}`);
        });
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
            if(btn) btn.innerText = "[ ] ENTER FULLSCREEN";
        }
    }
};



let db, auth;
try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
} catch(e) { console.error("Firebase Error:", e); }

let socket;
try {
    socket = io();
} catch (e) {}

// --- 2. GLOBAL VARIABLES ---

// --- 2. GLOBAL VARIABLES ---
window.canvas = null; window.ctx = null; window.inputField = null;
let currentRoomId = null; let myName = ""; let isHost = false; 
let roomUnsub = null; let myPlayerIndex = 0; let totalPlayers = 1;
let currentUser = null; 
let pendingGameMode = 'solo'; 
let scoreInterval = null;
let myDocId = null; 

let autoStartTimer = null; 
let isAutoStarting = false;
let intermissionSeconds = 10;
// ✅ NEW: Variable to store the saved session without acting on it yet
let pendingSessionData = null; 

// --- 💾 SESSION & HEARTBEAT MANAGERS ---
function saveSession(role, room, name, docId) {
    sessionStorage.setItem('jess_session', JSON.stringify({ 
        role, room, name, docId, time: Date.now() 
    }));
}

function clearSession() {
    sessionStorage.removeItem('jess_session');
    pendingSessionData = null;
}

// MODIFIED: Loads data but DOES NOT auto-join. Waits for user click.
function restoreSession() {
    const sess = sessionStorage.getItem('jess_session');
    
    // If no session, ensure we are clean
    if (!sess) {
        document.body.classList.remove('dashboard-active');
        const dash = document.getElementById("teacher-dashboard");
        if(dash) dash.classList.add("hidden");
        return;
    }

    let data;
    try { 
        data = JSON.parse(sess); 
    } catch (e) { 
        clearSession(); 
        return; 
    }

    // Only restore if session is less than 2 hours old
    if (Date.now() - data.time > 7200000) { 
        clearSession(); 
        return; 
    }

    console.log("🔄 SESSION FOUND (STANDBY):", data);
    
    // Store data in memory, but stay on Main Menu
    pendingSessionData = data;
    
    // Pre-fill name for convenience
    myName = data.name;
    const nameInput = document.getElementById("my-name");
    if (nameInput) nameInput.value = myName; 
    
    // Restore ID if available
    if (data.docId) myDocId = data.docId;
}


// ==========================================
// 🎛️ DASHBOARD TAB CONTROLLER (THE EXECUTIONER)
// ==========================================
window.switchDashTab = function(tabName, event) {
    if(window.Sound && event) window.Sound.click();
    
    // 1. EXECUTION PROTOCOL: Durugin ang espasyo ng lahat ng hindi active na tabs!
    document.querySelectorAll('.dash-view').forEach(d => {
        d.classList.add('hidden');
        d.style.setProperty('display', 'none', 'important'); // Patayin sa paningin
        d.style.setProperty('height', '0px', 'important');   // Tanggalin ang height
        d.style.setProperty('flex-grow', '0', 'important');  // Bawal umagaw ng space
        d.style.setProperty('padding', '0', 'important');
        d.style.setProperty('margin', '0', 'important');
    });
    
    // 2. Tanggalin ang highlight sa lahat ng buttons
    // ✅ BAGO
    document.querySelectorAll('#dash-tabs-bar .tab-btn').forEach(b => {
       b.classList.remove('active');
    });
    
    // 3. RESURRECTION PROTOCOL: Ibanat ang napiling tab nang buong-buo!
    const selectedView = document.getElementById(`view-${tabName}`);
    if (selectedView) {
        selectedView.classList.remove('hidden');
        
        // I-override at angkinin ang 100% ng screen!
        selectedView.style.setProperty('display', 'flex', 'important');
        selectedView.style.setProperty('flex-direction', 'column', 'important');
        selectedView.style.setProperty('flex-grow', '1', 'important');
        selectedView.style.setProperty('height', '100%', 'important');
        selectedView.style.setProperty('width', '100%', 'important');
    }
    
    // 4. I-Highlight ang pinindot na button
    if(event && event.target) {
        event.target.classList.add('active');
    } else {
        const targetBtn = document.querySelector(`.tab-btn[onclick*="'${tabName}'"]`);
        if(targetBtn) targetBtn.classList.add('active');
    }

    // 5. I-Render LAmang ang kailangan
    setTimeout(() => {
        try {
            if(tabName === 'grid' && window.updateSpyView) window.updateSpyView();
            if(tabName === 'roster' && window.updateRosterView) window.updateRosterView();
            if(tabName === 'podium' && window.updatePodiumView) window.updatePodiumView();
            if(tabName === 'reports' && window.updateReportView) window.updateReportView();
        } catch(e) { console.error(e); }
    }, 50);
};

// ==========================================
// 🚀 DASHBOARD DEPLOYER (STRICT FULLSCREEN)
// ==========================================
window.createClassroom = async function() {
    console.log("Initializing Class Creation...");
    window.agentTelemetry = {};
    if(!window.validateName()) return;

    const classNameInput = document.getElementById('class-name-input');
    const className = classNameInput ? classNameInput.value : "Classroom";
    
    const timeDisplay = document.getElementById('time-display');
    const minutes = timeDisplay ? parseInt(timeDisplay.getAttribute('data-value')) : 2;

    const roundsDisplay = document.getElementById('rounds-display');
    const maxRounds = roundsDisplay ? parseInt(roundsDisplay.getAttribute('data-value')) : 1;
    
    const topicEl = document.querySelector('input[name="topic-select"]:checked');
    const topic = topicEl ? topicEl.value : 'integers';

    let selectedOps = [];
    if(topic === 'mixed') {
        selectedOps = ['+', '-', 'x', '÷', 'Alg']; 
    } else {
        if(document.getElementById('chk-add')?.checked) selectedOps.push('+');
        if(document.getElementById('chk-sub')?.checked) selectedOps.push('-');
        if(document.getElementById('chk-mul')?.checked) selectedOps.push('x');
        if(document.getElementById('chk-div')?.checked) selectedOps.push('÷');
        if(topic === 'algebra') selectedOps.push('Alg'); 
    }
    if(selectedOps.length === 0) selectedOps = ['+']; 

    const diffEl = document.querySelector('input[name="class-diff"]:checked');
    const difficulty = diffEl ? diffEl.value : 'medium';

    const code = "CLASS-" + Math.floor(1000 + Math.random() * 9000);
    currentRoomId = code; isHost = true; state.gameMode = 'classroom';

    if(typeof saveSession === 'function') saveSession('teacher', code, myName);

    // 🚨 STRICT DASHBOARD DEPLOYMENT 🚨
    try {
        document.body.classList.add('dashboard-active');

        const setupModal = document.getElementById('classroom-setup-modal');
        if (setupModal) setupModal.classList.add('hidden');
        
        const jessBtn = document.getElementById("jessbot-toggle-btn");
        const commsBtn = document.getElementById("comms-toggle-btn");
        if(jessBtn) jessBtn.style.display = "none";
        if(commsBtn) commsBtn.style.display = "none";
        
        // FORCE THE DASHBOARD TO BE THE ONLY THING ON SCREEN
        const dash = document.getElementById('teacher-dashboard');
        if (dash) {
            dash.classList.remove('hidden');
            dash.style.setProperty('display', 'flex', 'important'); 
            dash.style.setProperty('flex-direction', 'column', 'important');
            dash.style.setProperty('position', 'fixed', 'important');
            dash.style.setProperty('top', '0', 'important');
            dash.style.setProperty('left', '0', 'important');
            dash.style.setProperty('width', '100vw', 'important');
            dash.style.setProperty('height', '100vh', 'important');
            dash.style.setProperty('z-index', '999999', 'important');
            dash.style.setProperty('background', '#05070a', 'important');
        }

        const roomCodeEl = document.getElementById('dash-room-code');
        const statusEl = document.getElementById('dash-status');
        if (roomCodeEl) roomCodeEl.innerText = code.replace("CLASS-", ""); 
        if (statusEl) statusEl.innerText = "STATUS: WAITING FOR AGENTS...";
        
    } catch (uiError) {
        console.error("❌ UI CRITICAL ERROR:", uiError);
    }

    try {
        await setDoc(doc(db, "rooms", code), {
            host: myName, roomName: className, mode: 'classroom', status: 'waiting',
            currentRound: 0, maxRounds: maxRounds,
            config: { timeLimit: minutes * 60, difficulty: difficulty, topic: topic, ops: selectedOps },
            createdAt: new Date()
        });
        window.monitorClassroom(code);
    } catch (e) { 
        alert("Error creating class: " + e.message); 
    }
};

// ==========================================
// 🔄 DASHBOARD RESUME (FOR REFRESH)
// ==========================================
window.resumeClassSession = function() {
    if (!pendingSessionData) return;
    const data = pendingSessionData;

    if (data.role === 'teacher') {
        window.myName = data.name; 
        document.body.classList.add('dashboard-active'); 
        
        const startModal = document.getElementById("start-modal");
        if(startModal) startModal.classList.add("hidden");
        
        // FORCE THE DASHBOARD TO BE THE ONLY THING ON SCREEN AGAIN
        const dash = document.getElementById("teacher-dashboard");
        if(dash) {
            dash.classList.remove("hidden");
            dash.style.setProperty('display', 'flex', 'important'); 
            dash.style.setProperty('flex-direction', 'column', 'important');
            dash.style.setProperty('position', 'fixed', 'important');
            dash.style.setProperty('top', '0', 'important');
            dash.style.setProperty('left', '0', 'important');
            dash.style.setProperty('width', '100vw', 'important');
            dash.style.setProperty('height', '100vh', 'important');
            dash.style.setProperty('z-index', '999999', 'important');
            dash.style.setProperty('background', '#05070a', 'important');
        }
        
        const roomCodeEl = document.getElementById("dash-room-code");
        if(roomCodeEl) roomCodeEl.innerText = data.room.replace("CLASS-", "");
        
        currentRoomId = data.room;
        isHost = true;
        state.gameMode = 'classroom';
        if(window.monitorClassroom) window.monitorClassroom(data.room);

    } else if (data.role === 'student') {
        window.myName = data.name;
        document.body.classList.remove('dashboard-active');
        const startModal = document.getElementById("start-modal");
        if(startModal) startModal.classList.add("hidden");
        
        state.gameMode = 'classroom';
        currentRoomId = data.room;
        isHost = false;
        
        getDoc(doc(db, "rooms", data.room)).then(snap => {
            if (snap.exists()) {
                const rData = snap.data();
                if(window.enterClassroomLobby) window.enterClassroomLobby(data.room, rData.roomName);
            } else {
                alert("Cannot Resume: Class has ended or room invalid.");
                if(typeof clearSession === 'function') clearSession();
                
                // 🟢 PINALITAN: Soft Reset na, walang refresh!
                window.goHome(true); 
            }
        });
    }
};

// --- 3. ASSET MANAGER (Visuals) ---
const assets = {
    ships: {
        'turret_def': { src: 'ship_default.png', img: new Image() },
        'turret_gold': { src: 'ship_gold.png', img: new Image() },
        'turret_cyber': { src: 'ship_cyber.png', img: new Image() },
        'turret_tank': { src: 'ship_tank.png', img: new Image() }
    },
    enemies: {
        'enemy_def': { src: 'enemy_default.png', img: new Image() },
        'enemy_alien': { src: 'enemy_alien.png', img: new Image() },
        'enemy_glitch': { src: 'enemy_glitch.png', img: new Image() }
    },
    boss: {
        'boss_def': { src: 'boss_mech.png', img: new Image() },
        'boss_god': { src: 'boss_god.png', img: new Image() }
    },
    misc: {
        'city': { src: '', img: new Image() },
        'supply': { src: 'supply_crate.png', img: new Image() }
    }
};

let cityLoaded = false;
let supplyLoaded = false;

// Preload All Images
function loadGameAssets() {
    console.log("Loading System Assets...");
    
    // Load Categories
    ['ships', 'enemies', 'boss'].forEach(cat => {
        Object.keys(assets[cat]).forEach(key => {
            assets[cat][key].img.src = assets[cat][key].src;
        });
    });

    // Load Misc
    assets.misc.city.img.src = assets.misc.city.src;
    assets.misc.city.img.onload = () => { cityLoaded = true; };
    
    assets.misc.supply.img.src = assets.misc.supply.src;
    assets.misc.supply.img.onload = () => { supplyLoaded = true; };
}
loadGameAssets(); // Start loading immediately

// --- UPDATED GAME STATE (BULLETPROOF) ---
let state = {
    isPlaying: false, isPaused: false, isGlobalFreeze: false,
    score: 0, totalScore: 0, coins: 200, health: 100,
    level: 1, xp: 0, xpToNext: 50,
    spawnRate: 2500, difficulty: 'medium', selectedOps: ['+'], 
    bossActive: false, bossData: null, shake: 0,
    meteors: [], particles: [], lasers: [], stars: [], buildings: [], 
    nemesisList: [],
    equipped: { 
        turret: 'turret_def', 
        enemy: 'enemy_def', 
        boss: 'boss_def', 
        fx: 'fx_blue' 
    },
    upgradeLevels: { 
        upgrade_coin: 0, 
        upgrade_score: 0, 
        upgrade_health: 0 
    },
    // 🟢 GUARANTEED INITIALIZED ARRAYS
    gameHistory: [], 
    mistakes: [], 
    floatingTexts: [], shockwaves: [],
    lastTime: 0, spawnTimer: 0, scoreSubmitted: false, isSlowed: false,
    gameMode: 'vs', lastSkillTime: 0, 
    opponentState: { meteors: [], lasers: [], health: 100, score: 0 },
    timeRemaining: 120, maxTime: 120, mathCycle: 0, helpRequested: false,
    combo: 0, maxCombo: 0,
    bossAttackState: { charging: false, firing: false, chargeTimer: 0, targetX: 0 },
    training: { active: false, currentQ: null, mistakesFixed: 0 },
    inputLocked: false, lockTimer: null, classroomTopic: 'all', swarmCount: 12
};

// --- 📝 NEW LOGGER FUNCTION (Ito ang taga-lista ng lahat) ---
function registerAction(question, correctAnswer, userInput, status) {
    // status: 'correct', 'wrong', 'missed'
    state.gameHistory.push({
        q: question,
        a: correctAnswer,
        input: userInput,
        status: status,
        timestamp: Date.now()
    });
}

// ==========================================
// 🛡️ N.E.X.U.S. LEXICAL AUTO-CORRECT MATRIX (BRUTE FORCE TYPO HANDLER)
// ==========================================
window.nexusAutoCorrect = {
    // A
    "aljebra": "algebra", "algeba": "algebra", "algbra": "algebra", "algerba": "algebra", "algebruh": "algebra",
    "addishun": "addition", "adition": "addition", "plus": "addition", "add": "addition", "sum": "addition",
    "acut": "acute angle", "akut": "acute angle", "akyut": "acute angle",
    "ariel": "area", "areah": "area", "aria": "area",
    "asymptot": "asymptote", "asimptote": "asymptote", "asimtote": "asymptote",
    // B
    "base": "base", "bays": "base", "baise": "base",
    "bynomial": "binomial", "binomiyal": "binomial", "bynomeal": "binomial",
    "bos": "boss", "bosss": "boss", "bost": "boss", "monster": "boss", "kalaban": "boss",
    // C
    "calc": "calculus", "kalculus": "calculus", "calculs": "calculus", "kalkyulus": "calculus",
    "sirkol": "circle", "cerkel": "circle", "circl": "circle", "circel": "circle",
    "sirkumperens": "circumference", "circumferance": "circumference", "circmference": "circumference",
    "cowsign": "cosine", "cosin": "cosine", "cos": "cosine",
    "silinder": "cylinder", "cylindar": "cylinder", "cilinder": "cylinder",
    "kord": "chord", "cord": "chord",
    // D
    "divishun": "division", "devision": "division", "divide": "division", "div": "division",
    "denomenator": "denominator", "denaminator": "denominator", "dinominator": "denominator", "ilalim": "denominator",
    "dayameter": "diameter", "diametar": "diameter", "diamter": "diameter",
    "deribativ": "derivative", "derivatv": "derivative", "derive": "derivative",
    "difisile": "difficult", "dificult": "difficult", "hirap": "hard", "mahirap": "hard",
    // E
    "ekwasyon": "equation", "equasion": "equation", "equatn": "equation", "equat": "equation",
    "iksponent": "exponent", "exponant": "exponent", "expnent": "exponent", "power": "exponent",
    "ikwilateral": "equilateral", "equilataral": "equilateral",
    "emp": "emp", "nuke": "emp", "bomba": "emp", "sabog": "emp",
    // F
    "fruction": "fraction", "fracshun": "fraction", "frac": "fraction", "fraktion": "fraction", "praksyon": "fraction",
    "fakto": "factor", "factr": "factor", "facktor": "factor",
    "faktoryal": "factorial", "factoral": "factorial",
    "pors": "force", "fors": "force",
    "pormula": "formula", "formla": "formula", "pormula": "formula",
    // G
    "jeometry": "geometry", "geomtry": "geometry", "geomerty": "geometry", "jomtry": "geometry",
    "grabity": "gravity", "gravty": "gravity", "gravite": "gravity",
    "glitch": "glitch", "glets": "glitch", "bug": "glitch",
    // H
    "haypotenus": "hypotenuse", "hypotnuse": "hypotenuse", "hipotenuse": "hypotenuse", "hipotnuse": "hypotenuse",
    // I
    "intejer": "integer", "intiger": "integer", "intger": "integer", "whole number": "integer",
    "intersheksyun": "intersection", "intersect": "intersection",
    "irashunal": "irrational", "irational": "irrational",
    "isoseles": "isosceles", "isoceles": "isosceles", "isoseles": "isosceles",
    // L
    "layn": "linear", "linyar": "linear", "linar": "linear",
    "logaritm": "logarithm", "logaritham": "logarithm", "log": "logarithm",
    "lore": "lore", "kwento": "lore", "story": "lore", "history": "lore",
    // M
    "multyply": "multiplication", "multiply": "multiplication", "times": "multiplication", "multiplikasyon": "multiplication",
    "meydib": "median", "midyan": "median", "medin": "median",
    "mowd": "mode", "mod": "mode",
    "monomyal": "monomial", "monomeal": "monomial",
    "mothership": "boss", "mother ship": "boss", "nanay na barko": "boss",
    // N
    "numerater": "numerator", "numirator": "numerator", "numeraytor": "numerator", "taas": "numerator",
    "nalifayer": "nullifiers", "nullifier": "nullifiers", "alien": "nullifiers",
    // O
    "obtus": "obtuse", "obtyus": "obtuse", "obtoos": "obtuse",
    // P
    "parabola": "parabola", "parabula": "parabola", "parabol": "parabola",
    "piramiter": "perimeter", "perimetar": "perimeter", "primeter": "perimeter",
    "paytagorean": "pythagorean", "pythagoras": "pythagorean", "pythgorean": "pythagorean", "pitagoras": "pythagorean",
    "poligon": "polygon", "poligon": "polygon", "poliygon": "polygon",
    "praym": "prime", "pryme": "prime",
    "prabability": "probability", "probabilty": "probability", "prob": "probability",
    "pi": "pi", "pie": "pi", "3.14": "pi",
    "parallel": "parallel", "paralel": "parallel", "paralell": "parallel",
    "perpendikular": "perpendicular", "perpendiclar": "perpendicular",
    // Q
    "kwadrant": "quadrant", "quadrnt": "quadrant",
    "kwadratik": "quadratic", "quadratik": "quadratic", "quadratc": "quadratic",
    "kwadrilateral": "quadrilateral", "quadrilatral": "quadrilateral",
    "kwosyent": "quotient", "quotiant": "quotient", "qoutient": "quotient",
    // R
    "reyjus": "radius", "radus": "radius", "radis": "radius",
    "rasyo": "ratio", "ratiyo": "ratio",
    "resiprokal": "reciprocal", "reciprokel": "reciprocal",
    "rombos": "rhombus", "rombus": "rhombus", "rhombos": "rhombus",
    "reyt": "rate", "rait": "rate",
    // S
    "sayn": "sine", "sin": "sine",
    "slowp": "slope", "slop": "slope",
    "ispir": "sphere", "spher": "sphere",
    "iskwer": "square", "skwer": "square", "sqare": "square", "sqaure": "square",
    "simetri": "symmetry", "symetry": "symmetry", "symetry": "symmetry",
    "sekant": "secant", "secnt": "secant",
    "sektor": "sector", "sectr": "sector",
    "istats": "status", "stat": "status", "skor": "status", "istatus": "status",
    "sloy": "slow", "bagal": "slow", "slo": "slow",
    "sworm": "swarm", "dami": "swarm",
    // T
    "tanjent": "tangent", "tanjnt": "tangent", "tan": "tangent",
    "tiyorem": "theorem", "theorm": "theorem", "theoram": "theorem",
    "trayanggulo": "triangle", "triangl": "triangle", "triangel": "triangle", "traingle": "triangle", "tryangle": "triangle",
    "trapezoyd": "trapezoid", "trapezod": "trapezoid",
    "taym": "time", "oras": "time",
    "trigo": "trigonometry", "trig": "trigonometry", "trigonometre": "trigonometry",
    // V
    "baryabol": "variable", "varable": "variable", "varible": "variable",
    "vektor": "vector", "vectr": "vector",
    "berteks": "vertex", "vertix": "vertex",
    "bolyum": "volume", "volum": "volume", "volym": "volume",
    "belositi": "velocity", "velosity": "velocity", "velocty": "velocity",
    // W
    "wiknes": "weakness", "weaknes": "weakness", "hina": "weakness", "mali": "weakness",
    // Z
    "ziro": "zero", "ziroh": "zero", "sero": "zero"
};

// 🟢 THE SANITIZER FUNCTION (Translates Typos into Perfect English before AI reads it)
window.sanitizeQuery = function(rawText) {
    let words = rawText.toLowerCase().replace(/[?!.,;'"]/g, '').split(/\s+/);
    for (let i = 0; i < words.length; i++) {
        if (window.nexusAutoCorrect[words[i]]) {
            // Kung nasa Matrix ang maling spelling, palitan agad ng tama!
            words[i] = window.nexusAutoCorrect[words[i]];
        }
    }
    return words.join(" ");
};

// --- AUTH & RANK SYSTEM ---
window.switchTab = function(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
    
    if (tab === 'login') {
        document.getElementById('login-form').classList.remove('hidden');
        document.querySelector('.tab-btn:first-child').classList.add('active');
    } else {
        document.getElementById('register-form').classList.remove('hidden');
        document.querySelector('.tab-btn:last-child').classList.add('active');
    }
    document.getElementById('auth-msg').innerText = "";
};

window.registerUser = async function() {
    const name = document.getElementById('reg-username').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const pass = document.getElementById('reg-pass').value;
    const msg = document.getElementById('auth-msg');

    if (!name || !email || !pass) { msg.innerText = "FILL ALL FIELDS"; return; }
    
    msg.innerText = "CREATING IDENTITY...";
    try {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        
        // SA LOOB NG window.registerUser (Palitan ang setDoc block nito):
        await setDoc(doc(db, "users", cred.user.uid), {
            username: name.toUpperCase(),
            searchName: name.toLowerCase(), // 🟢 NEW: For searching
            email: email,
            totalXP: 0,
            rank: "CADET",
            coins: 200,             
            matchHistory: [],       
            inventory: ['turret_def', 'enemy_def', 'boss_def', 'fx_blue'], 
            equipped: { turret: 'turret_def', fx: 'fx_blue', enemy: 'enemy_def', boss: 'boss_def' },
            friends: [],            // 🟢 NEW: Friends List
            friendRequests: [],     // 🟢 NEW: Pending requests
            createdAt: new Date()
        });
        msg.innerText = "SUCCESS! LOGGING IN...";
    } catch (e) {
        msg.innerText = "ERROR: " + e.message;
    }
};

window.loginUser = async function() {
    const email = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-pass').value;
    const msg = document.getElementById('auth-msg');

    msg.innerText = "ACCESSING MAINFRAME...";
    try {
        await signInWithEmailAndPassword(auth, email, pass);
    } catch (e) {
        msg.innerText = "ACCESS DENIED: " + e.message;
        if(window.Sound) window.Sound.error();
    }
};

window.logoutUser = function() {
    signOut(auth);
    location.reload(); // Ito ay nagpapa-refresh
};
window.playAsGuest = function() {
    const originalGuestBtn = document.getElementById('guest-option');
    if(originalGuestBtn) originalGuestBtn.classList.add('hidden');

    const authSection = document.getElementById('auth-section');
    
    // Tinago muna natin ang orig HTML content sa memory para mabalik
    if(!window.origAuthHTML) window.origAuthHTML = authSection.innerHTML;

    authSection.innerHTML = `
        <div id="name-container">
            <input type="text" id="my-name" class="main-input" placeholder="ENTER GUEST NAME" maxlength="10">
        </div>
        
        <button class="btn primary" onclick="window.startSolo()">🚀 SOLO</button>
        <button class="btn secondary" onclick="window.showMultiplayerMenu()">⚔️ MULTIPLAYER</button>
        
        <div style="margin-top: 15px; border-top: 1px solid #333; padding-top: 10px;">
            <button class="btn text-only" onclick="window.cancelGuestMode()">⬅ BACK TO LOGIN</button>
        </div>
    `;
};

// Idagdag itong helper function sa JS
window.cancelGuestMode = function() {
    if(window.Sound) window.Sound.click();
    const authSection = document.getElementById('auth-section');
    if(window.origAuthHTML) authSection.innerHTML = window.origAuthHTML; // Restore Original Menu
    
    const originalGuestBtn = document.getElementById('guest-option');
    if(originalGuestBtn) originalGuestBtn.classList.remove('hidden');
};

function getRankInfo(xp) {
    if (xp < 1000) return { title: "CADET", icon: "🔰", next: 1000 };
    if (xp < 5000) return { title: "OFFICER", icon: "👮", next: 5000 };
    if (xp < 10000) return { title: "SPECIAL AGENT", icon: "🕵️", next: 10000 };
    if (xp < 25000) return { title: "COMMANDER", icon: "🎖️", next: 25000 };
    return { title: "MATH WARLORD", icon: "👑", next: 999999 };
}

if (auth) {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const docRef = doc(db, "users", user.uid);
            const docSnap = await getDoc(docRef);
            
            if (docSnap.exists()) {
                // 1. Assign Data
                currentUser = docSnap.data();
                currentUser.uid = user.uid;
                myName = currentUser.username; 
                
                // 2. Self-Repair Protocol
                let needsUpdate = false;
                let updates = {};

                if (!currentUser.matchHistory) { currentUser.matchHistory = []; updates.matchHistory = []; needsUpdate = true; }
                if (currentUser.coins === undefined) { currentUser.coins = 200; updates.coins = 200; needsUpdate = true; }
                if (!currentUser.inventory) { 
                    updates.inventory = ['turret_def', 'enemy_def', 'boss_def', 'fx_blue']; 
                    currentUser.inventory = updates.inventory;
                    needsUpdate = true; 
                }
                if (!currentUser.equipped) {
                    updates.equipped = { turret: 'turret_def', fx: 'fx_blue', enemy: 'enemy_def', boss: 'boss_def' };
                    currentUser.equipped = updates.equipped;
                    needsUpdate = true;
                }
                if (!currentUser.campaignChapter) { 
                    currentUser.campaignChapter = 1; 
                    updates.campaignChapter = 1; 
                    needsUpdate = true; 
                }
                if (!currentUser.searchName) { currentUser.searchName = myName.toLowerCase(); updates.searchName = myName.toLowerCase(); needsUpdate = true; }
                if (!currentUser.friends) { currentUser.friends = []; updates.friends = []; needsUpdate = true; }
                if (!currentUser.friendRequests) { currentUser.friendRequests = []; updates.friendRequests = []; needsUpdate = true; }

                if (needsUpdate) {
                    await updateDoc(docRef, updates);
                }

                // 3. UI UPDATES (MAIN DASHBOARD)
                document.getElementById('auth-section').classList.add('hidden');
                document.getElementById('guest-option').classList.add('hidden');
                document.getElementById('profile-section').classList.remove('hidden');
                
                let currentXP = currentUser.totalXP || 0;
                const rankData = getRankInfo(currentXP);
                
                const nameDisplay = document.getElementById('agent-name-display');
                if (nameDisplay) nameDisplay.innerText = myName;
                
                const rankTitle = document.getElementById('rank-title');
                if (rankTitle) rankTitle.innerText = rankData.title;
                
                const rankIcon = document.getElementById('rank-icon');
                if (rankIcon) rankIcon.innerText = rankData.icon;
                
                const xpText = document.getElementById('xp-text');
                if (xpText) xpText.innerText = `${currentXP} / ${rankData.next} XP`;
                
                let xpPercent = Math.min(100, (currentXP / rankData.next) * 100);
                const xpFill = document.getElementById('profile-xp-fill');
                if (xpFill) xpFill.style.width = xpPercent + "%";

                const dashCoins = document.getElementById('dash-coins-display');
                if (dashCoins) dashCoins.innerText = currentUser.coins || 0;

                if (window.syncShopData) window.syncShopData(currentUser);
                
                let currentAvatar = currentUser.avatar || 'https://img.icons8.com/color/96/000000/astronaut.png';
                const avatarImg = document.getElementById("dash-avatar-img");
                if (avatarImg) avatarImg.src = currentAvatar;

                if (window.Sound) window.Sound.speak("Welcome back, " + myName);

                // ====================================
                // 4. LIVE SYSTEMS INITIALIZATION
                // ====================================
                if (window.initCommsListener) window.initCommsListener();

                if (socket) {
                    socket.emit('register_player', { name: myName, uid: currentUser.uid });
                }

                // 🟢 THE FIX: Tawagin ang Orbs Controller para Ipakita sila sa Dashboard!
                setTimeout(() => {
                    if(window.updateOrbsVisibility) window.updateOrbsVisibility();
                }, 500); // 500ms delay para siguradong tapos na ang intro animations
            }
        } else {
            document.getElementById('auth-section').classList.remove('hidden');
            document.getElementById('guest-option').classList.remove('hidden');
            document.getElementById('profile-section').classList.add('hidden');
            
            // 🟢 FORCE HIDE ORBS KAPAG NASA LOGIN SCREEN
            if(window.updateOrbsVisibility) window.updateOrbsVisibility(true);
        }
    });
}

// --- OPTIMIZED HUD & SOUND ---
const hudCache = {
    score: null, coins: null, health: null, level: null, xpPercent: null
};

function updateHUD() {
    // 1. Update Score
    if (state.score !== hudCache.score) {
        const elScore = document.getElementById("score-txt");
        if(elScore) elScore.innerHTML = `${state.score}`;
        hudCache.score = state.score;
    }

    // 2. Update Coins
    // 2. Update Coins
    if (state.coins !== hudCache.coins) {
        const elCoins = document.getElementById("coins-txt");
        if(elCoins) elCoins.innerHTML = `${state.coins}`;
        
        // 🟢 NEW FIX: I-update din ang pera sa Main Dashboard
        const dashCoins = document.getElementById("dash-coins-display");
        if(dashCoins) dashCoins.innerText = state.coins;

        hudCache.coins = state.coins;
    }

    // 3. Update Health AND Timer
    const elLabel = document.querySelector("#hud-top .center .hud-box .label");
    const elHealth = document.getElementById("health-txt");

    if (state.gameMode === 'classroom') {
        // 🟢 COMBINED MODE: Ipakita ang Time At Health
        let mins = Math.floor(state.timeRemaining / 60);
        let secs = Math.floor(state.timeRemaining % 60);
        let timeStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        
        if(elLabel) elLabel.innerText = "HULL | TIMER";
        if(elHealth) {
            elHealth.innerText = `${state.health}% | ${timeStr}`;
            elHealth.style.color = state.health < 30 || state.timeRemaining < 10 ? "#ff0055" : "#00ff41";
        }
        
        if (state.health < 30) document.body.classList.add('critical-health');
        else document.body.classList.remove('critical-health');
        
        hudCache.health = state.health;
    } else {
        // NORMAL HEALTH MODE (Solo/Party)
        if(elLabel) elLabel.innerText = "HULL INTEGRITY";

        if (state.health !== hudCache.health) {
            if(elHealth) {
                elHealth.innerText = state.health + "%";
                elHealth.style.color = state.health < 30 ? "#ff0000" : (state.health < 60 ? "#ffff00" : "#00ff41");
            }
            if (state.health < 30) document.body.classList.add('critical-health');
            else document.body.classList.remove('critical-health');
            hudCache.health = state.health;
        }
    }

    // 4. Update Level
    if (state.level !== hudCache.level) {
        const elLevel = document.getElementById("level-txt");
        if(elLevel) elLevel.innerText = state.level;
        hudCache.level = state.level;
    }

    // 5. Update XP Bar
    let currentXpPercent = (state.xp / 50) * 100;
    if(state.bossActive) currentXpPercent = 100;

    if (Math.abs(currentXpPercent - hudCache.xpPercent) > 1 || currentXpPercent === 0 || currentXpPercent === 100) {
        const elXpFill = document.getElementById("xp-bar-fill");
        if(elXpFill) elXpFill.style.width = currentXpPercent + "%";
        hudCache.xpPercent = currentXpPercent;
    }

    // 6. Boss HUD
    let bossHud = document.getElementById("boss-hud");
    let bossWarning = document.getElementById("boss-warning");
    
    if (state.bossActive && state.bossData) {
        if(bossHud && bossHud.classList.contains("hidden")) bossHud.classList.remove("hidden");
        if(bossWarning && bossWarning.classList.contains("hidden")) bossWarning.classList.remove("hidden");
        
        let hpPercent = (state.bossData.hp / state.bossData.maxHp) * 100;
        let hpFill = document.getElementById("boss-hp-fill");
        if(hpFill) hpFill.style.width = hpPercent + "%";
        
        let bossName = document.getElementById("boss-name");
        if(bossName) bossName.innerText = `BOSS LVL ${state.level}`;
    } else { 
        if(bossHud && !bossHud.classList.contains("hidden")) bossHud.classList.add("hidden");
        if(bossWarning && !bossWarning.classList.contains("hidden")) bossWarning.classList.add("hidden");
    }
    
    // 7. Combo Logic
    const comboEl = document.getElementById("combo-container");
    if(comboEl) {
        if(state.combo < 2 && !comboEl.classList.contains("hidden")) comboEl.classList.add("hidden");
    }
}
window.updateHUD = updateHUD;

// ==========================================
// 🔊 THE FINAL SOUND ENGINE (PRO AUDIO)
// ==========================================
window.Sound = {
    ctx: null,
    masterGain: null,
    isMuted: false,
    activeNodes: [], // Tracks active oscillators/intervals
    currentMode: null,
   
// PRESETS
    laser: function() { 
        if(!this.ctx) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(1200, t);
        o.frequency.exponentialRampToValueAtTime(100, t + 0.2); 
        g.gain.setValueAtTime(0.3, t); 
        g.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
        o.connect(g); g.connect(this.masterGain);
        o.start(); o.stop(t + 0.2);
    }, 
    boom: function() { this.playTone(50, 'square', 0.5, 0.6); }, 
    error: function() { this.playTone(150, 'sawtooth', 0.2, 0.2); }, 
    
    // 🟢 ITO ANG NAWAWALA NA NAGPAPACRASH SA BOSS AT EMP!
    nuke: function() { this.playTone(30, 'square', 2.0, 0.8); }, 
    
    powerup: function() {
        if(!this.ctx) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.frequency.setValueAtTime(400, t);
        o.frequency.linearRampToValueAtTime(2000, t + 0.5); 
        g.gain.setValueAtTime(0.2, t);
        g.gain.linearRampToValueAtTime(0, t + 0.5);
        o.connect(g); g.connect(this.masterGain);
        o.start(); o.stop(t + 0.5);
    },
    click: function() { 
        if(!this.ctx) this.init(); 
        this.playTone(1000, 'sine', 0.05, 0.1); 
    },

    // --- 1. INITIALIZATION ---
    init: function() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
            
            // MASTER VOLUME LIMITER (Tinaasan sa 0.6 para malakas)
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0.6; 
            this.masterGain.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().catch(e => console.log("Audio waiting for user..."));
        }
    },

    // --- 2. TOGGLE MUTE ---
    toggle: function() {
        this.isMuted = !this.isMuted;
        if (this.masterGain && this.ctx) {
            const now = this.ctx.currentTime;
            this.masterGain.gain.cancelScheduledValues(now);
            this.masterGain.gain.linearRampToValueAtTime(this.isMuted ? 0 : 0.6, now + 0.5);
        }
        return this.isMuted;
    },

    // --- 3. VOICE COMMANDER (Sci-Fi Voice) ---
    speak: function(text) {
        if (this.isMuted || !('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0; 
        u.pitch = 0.8; // Deep authoritative voice
        u.volume = 1.0;
        const v = window.speechSynthesis.getVoices().find(v => v.name.includes('Google US English') || v.name.includes('Zira'));
        if (v) u.voice = v;
        window.speechSynthesis.speak(u);
    },

    // --- 4. HIGH-TECH SFX (Filtered) ---
    playTone: function(freq, type, duration, vol = 0.1) {
        if (!this.ctx || this.isMuted) return;
        try {
            const t = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const filter = this.ctx.createBiquadFilter(); 

            osc.type = type;
            osc.frequency.setValueAtTime(freq, t);
            
            // Lowpass Filter removes the "Sabog/Buzz" sound
            filter.type = "lowpass";
            filter.frequency.setValueAtTime(1200, t); 

            // Envelopes (Smooth Attack/Release)
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(vol, t + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.masterGain);
            
            osc.start(t);
            osc.stop(t + duration);
            
            setTimeout(() => { osc.disconnect(); }, duration * 1000 + 100);
        } catch (e) {}
    },

    // --- 🌠 SHOOTING STAR EFFECT (NEW) ---
    starSweep: function() {
        if (!this.ctx || this.isMuted) return;
        try {
            const t = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            const f = this.ctx.createBiquadFilter();

            // Mabilis na pagtaas ng pitch (Swoosh effect)
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(200, t);
            osc.frequency.exponentialRampToValueAtTime(3000, t + 0.5); 

            f.type = 'bandpass';
            f.frequency.value = 2000;

            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.3, t + 0.1);
            g.gain.linearRampToValueAtTime(0, t + 0.5);

            osc.connect(f); f.connect(g); g.connect(this.masterGain);
            osc.start(); osc.stop(t + 0.5);
        } catch(e) {}
    },

    // PRESETS
    laser: function() { 
        if(!this.ctx) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.frequency.setValueAtTime(900, t);
        o.frequency.exponentialRampToValueAtTime(100, t + 0.2); // Pitch slide down
        g.gain.setValueAtTime(0.4, t); 
        g.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
        o.connect(g); g.connect(this.masterGain);
        o.start(); o.stop(t + 0.2);
    }, 

    boom: function() { this.playTone(60, 'square', 0.4, 0.6); }, // Solid explosion
    error: function() { this.playTone(150, 'sawtooth', 0.2, 0.2); }, 

    powerup: function() { 
        if(!this.ctx) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.frequency.setValueAtTime(400, t);
        o.frequency.linearRampToValueAtTime(1500, t + 0.4); // Rising pitch
        g.gain.setValueAtTime(0.2, t);
        g.gain.linearRampToValueAtTime(0, t + 0.4);
        o.connect(g); g.connect(this.masterGain);
        o.start(); o.stop(t + 0.4);
    },

    click: function() { 
        if(!this.ctx) this.init(); // Ensure init on click
        this.playTone(1200, 'sine', 0.05, 0.08); 
    },

    // --- 5. ATMOSPHERIC BGM ENGINE ---
    playBGM: function(mode) {
        this.init(); // Ensure context exists
        if (!this.ctx || this.isMuted || this.currentMode === mode) return;
        
        this.stopBGM(); 
        this.currentMode = mode;
        const t = this.ctx.currentTime;

        if (mode === 'intro') {
            // === INTRO: CINEMATIC RUMBLE + STARS ===
            
            // Layer 1: Deep Engine Growl
            const osc1 = this.ctx.createOscillator();
            const g1 = this.ctx.createGain();
            osc1.type = 'sawtooth';
            osc1.frequency.setValueAtTime(40, t);
            osc1.frequency.linearRampToValueAtTime(100, t + 6); // Rising engine
            
            // Filter para hindi masakit sa tenga ang growl
            const f1 = this.ctx.createBiquadFilter();
            f1.type = 'lowpass';
            f1.frequency.value = 400;

            g1.gain.value = 0.5;

            osc1.connect(f1); f1.connect(g1); g1.connect(this.masterGain);
            osc1.start();
            this.activeNodes.push(osc1, g1, f1);

            // Layer 2: Automatic Star Sweeps (Random)
            const starInterval = setInterval(() => {
                if(this.currentMode === 'intro' && Math.random() > 0.4) {
                    this.starSweep();
                }
            }, 600); // Check every 600ms
            this.activeNodes.push({ stop: () => clearInterval(starInterval) });
        } 
        else if (mode === 'menu') {
            // === MENU: Relaxing Deep Space ===
            this.createPad(220, 'sine', 0.25);    // Chord note 1
            this.createPad(261.63, 'sine', 0.2);  // Chord note 2
            this.createPad(110, 'triangle', 0.15); // Sub-base drone
        } 
        else if (mode === 'battle') {
            // === BATTLE: Cyber Heartbeat (Maangas) ===
            this.createPad(55, 'sawtooth', 0.2); // Low synth bass
            
            let beat = 0;
            const sequencer = setInterval(() => {
                if (this.isMuted || this.currentMode !== 'battle') return;
                const now = this.ctx.currentTime;
                
                // Pulsing Beat (Kick Drum Effect)
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                const flt = this.ctx.createBiquadFilter();
                
                osc.frequency.setValueAtTime(120, now);
                osc.frequency.exponentialRampToValueAtTime(0.01, now + 0.4); 
                
                flt.type = "lowpass";
                flt.frequency.value = 150; // Muffled Kick
                
                gain.gain.setValueAtTime(0.5, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
                
                osc.connect(flt); flt.connect(gain); gain.connect(this.masterGain);
                osc.start(now); osc.stop(now + 0.5);
                
                // High Hat / Ping every 4 beats
                if (beat % 4 === 0) this.playTone(880, 'sine', 0.05, 0.05); 
                beat++;
            }, 500); // Heartbeat tempo
            
            this.activeNodes.push({ stop: () => clearInterval(sequencer) });
        }
    },

    // Helper: Creates a smooth background tone
    createPad: function(freq, type, vol) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();

        osc.type = type;
        osc.frequency.value = freq;
        filter.type = 'lowpass';
        filter.frequency.value = 350; // Muffled/Relaxing filter

        gain.gain.setValueAtTime(0, this.ctx.currentTime);
        gain.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + 2.5); // Slow fade in

        osc.connect(filter); filter.connect(gain); gain.connect(this.masterGain);
        osc.start();
        
        const node = { 
            stop: () => {
                try {
                    gain.gain.cancelScheduledValues(this.ctx.currentTime);
                    gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1.5); // Fade out
                    setTimeout(() => { osc.stop(); osc.disconnect(); }, 1600);
                } catch(e){}
            }
        };
        this.activeNodes.push(node);
        return node;
    },

    stopBGM: function() {
        this.activeNodes.forEach(n => {
            if (n.stop) n.stop();
            else { try { n.stop(); n.disconnect(); } catch(e){} }
        });
        this.activeNodes = [];
        this.currentMode = null;
    }
};

// --- AUDIO TRIGGERS (Injecting logic into existing game flow) ---

// 1. GLOBAL UNLOCK (Solves "No Sound on Load" issue)
document.addEventListener('click', () => {
    if (window.Sound) {
        window.Sound.init(); // Piliting gisingin ang Audio Engine
        if (window.Sound.ctx && window.Sound.ctx.state === 'suspended') {
            window.Sound.ctx.resume();
        }
    }
}, { once: true });

// 2. INTRO MUSIC
const originalIntroLoad = window.onload; // Hook into load
window.addEventListener('load', () => {
    setTimeout(() => { 
        if(window.Sound) {
            window.Sound.playBGM('intro');
            // Sound.speak("System initialized.");
        }
    }, 1000);
});

// ==========================================
// 🛡️ THE ULTIMATE FAILSAFE OVERRIDE
// ==========================================

// ==========================================
// 🛡️ THE ULTIMATE BRUTE-FORCE MENU TRIGGER
// ==========================================

window.skipStory = function() {
    if(window.Sound && window.Sound.click) window.Sound.click();
    
    // 1. Walang awa nating papatayin ang lahat ng Story at Intro screens
    document.querySelectorAll('#story-overlay, #cinematic-intro').forEach(el => {
        el.style.display = 'none';
        el.classList.add('hidden');
    });

    // 2. NUCLEAR DEPLOYMENT: Hanapin ang Start Modal (Kahit ilan pa sila) at piliting ilabas!
    const startModals = document.querySelectorAll('#start-modal');
    startModals.forEach(modal => {
        modal.classList.remove('hidden');
        modal.classList.add('nuclear-show'); // Gagamitin nito yung CSS sa itaas
    });

    // 3. I-play ang Menu Music
    if(window.Sound && window.Sound.playBGM) window.Sound.playBGM('menu');

    window.updateOrbsVisibility();
    
    // 4. Silipin kung may active class
    if(window.restoreSession) window.restoreSession();
};

window.startStoryMode = function() {
    // Patayin ang intro at simulan ang kwento
    document.querySelectorAll('#cinematic-intro').forEach(el => el.style.display = 'none');
    
    const storyOverlay = document.getElementById('story-overlay');
    if (storyOverlay) {
        storyOverlay.classList.remove('hidden');
        storyOverlay.style.display = 'flex';
        storyOverlay.style.zIndex = '999999';
    }
    
    if(window.Sound && window.Sound.playBGM) window.Sound.playBGM('menu'); 
    if(window.Sound && window.Sound.playTone) window.Sound.playTone(600, 'sine', 0.1);
    
    if(typeof showStoryStep === "function") showStoryStep(0);
};



// --- 🧠 SMART MATH GENERATOR (DYNAMIC CURRICULUM) ---
function generateMath(isHard) {
    let op, n1, n2, equation, answer;
    let maxNum = 10;
    let allowNeg = false;
    let isAlgebra = false;

    // 🟢 CHECK KUNG NASA CAMPAIGN MODE
    if (state.gameMode === 'campaign') {
        let level = state.currentCampaignLevel; // 1 to 100

        // Sector 1: Addition & Subtraction (Levels 1-20)
        if (level <= 20) {
            op = Math.random() > 0.5 ? '+' : '-';
            maxNum = 5 + Math.floor(level * 1.5); // Habang tumataas ang level, lumalaki ang numbers (up to ~35)
        } 
        // Sector 2: Multiplication & Division (Levels 21-50)
        else if (level <= 50) {
            op = Math.random() > 0.5 ? 'x' : '÷';
            maxNum = 5 + Math.floor((level - 20) * 0.5); // Max up to ~20 multiplier
        } 
        // Sector 3: Integers / Negatives (Levels 51-80)
        else if (level <= 80) {
            const ops = ['+', '-', 'x', '÷'];
            op = ops[Math.floor(Math.random() * ops.length)];
            maxNum = 10 + Math.floor((level - 50) * 0.5);
            allowNeg = true; // Pumapasok na ang Negative Numbers!
        } 
        // Sector 4: Algebra (Levels 81-100)
        else {
            isAlgebra = true;
            op = Math.random() > 0.5 ? '+' : 'x'; // Simple algebra
            maxNum = 12;
            allowNeg = true;
        }
    } 
    // 🔵 KUNG NORMAL SURVIVAL MODE O MULTIPLAYER
    else {
        let ops = state.selectedOps || ['+'];
        if (ops.includes('Alg')) {
            isAlgebra = true;
            let innerOps = ops.filter(o => o !== 'Alg');
            op = innerOps.length > 0 ? innerOps[Math.floor(Math.random() * innerOps.length)] : '+';
        } else {
            op = ops[Math.floor(Math.random() * ops.length)];
        }
        
        if (state.difficulty === 'hard') { maxNum = 30; allowNeg = true; }
        else if (state.difficulty === 'medium') { maxNum = 20; allowNeg = Math.random() < 0.3; }
    }

    // --- NUMBER GENERATION HELPER ---
    const getNum = (max, neg) => {
        let n = Math.floor(Math.random() * max) + 1;
        if (neg && Math.random() > 0.5) n *= -1;
        return n;
    };

    // --- ALGEBRA LOGIC ---
    if (isAlgebra) {
        let x = getNum(12, allowNeg); // Ito ang isasagot ng player
        let constant = getNum(10, allowNeg);
        let result;

        if (op === '+') { // x + 5 = 15
            result = x + constant;
            equation = constant < 0 ? `x - ${Math.abs(constant)} = ${result}` : `x + ${constant} = ${result}`;
        } else if (op === 'x') { // 3x = 12
            constant = Math.abs(getNum(9, false)) + 2; // avoid 0 or 1
            result = constant * x;
            equation = `${constant}x = ${result}`;
        } else {
            result = x + constant;
            equation = `x + ${constant} = ${result}`;
        }
        answer = x;
    } 
    // --- BASIC ARITHMETIC LOGIC ---
    else {
        n1 = getNum(maxNum, allowNeg);
        n2 = getNum(maxNum, allowNeg);

        if (op === '+') { equation = `${n1} + ${n2}`; answer = n1 + n2; }
        else if (op === '-') { 
            // Avoid negative answers kung hindi pa bawal (para sa lower levels)
            if (!allowNeg && n1 < n2) { let temp = n1; n1 = n2; n2 = temp; }
            equation = `${n1} - ${n2}`; answer = n1 - n2; 
        }
        else if (op === 'x') { equation = `${n1} x ${n2}`; answer = n1 * n2; }
        else if (op === '÷') { 
            // Ensure clean division (walang butal)
            let ans = getNum(12, allowNeg);
            n2 = Math.abs(n2) || 2; 
            let dividend = n2 * ans;
            equation = `${dividend} ÷ ${n2}`; answer = ans; 
        }
    }

    // Kung galing sa Boss, laging mas mahirap ng konti
    if (isHard && !isAlgebra) {
        equation = "⚠️ " + equation; 
    }

    return { q: equation, a: answer };
}

// --- VISUAL SETUP ---
function initStars() { 
    if(!window.canvas) return;
    state.stars=[]; 
    for(let i=0;i<80;i++) {
        state.stars.push({
            x:Math.random()*window.canvas.width, 
            y:Math.random()*window.canvas.height, 
            size:Math.random()*1.5, speed:Math.random()*0.4+0.1
        }); 
    }
}
function generateCity() {
    if (!cityLoaded && window.canvas) {
        state.buildings = []; let x=0;
        while(x<window.canvas.width) {
            let w=Math.random()*80+40; let h=Math.random()*150+50; let wins=[]; 
            for(let wx=10;wx<w-10;wx+=20) wins.push({x:wx, h:h-10, lit:Math.random()>0.3});
            state.buildings.push({x:x,w:w,h:h,wins:wins}); x+=w-2;
        }
    }
}
function captureSettings() {
    let diffEl = document.querySelector('input[name="diff"]:checked');
    state.difficulty = diffEl ? diffEl.value : 'medium';
    state.selectedOps = [];
    if (document.getElementById('opt-add')?.checked) state.selectedOps.push('+');
    if (document.getElementById('opt-sub')?.checked) state.selectedOps.push('-');
    if (document.getElementById('opt-mul')?.checked) state.selectedOps.push('x');
    if (document.getElementById('opt-div')?.checked) state.selectedOps.push('÷');
    if (document.getElementById('opt-alg')?.checked) state.selectedOps.push('Alg');
    if (state.selectedOps.length === 0) state.selectedOps.push('+');
    if (state.difficulty === 'easy') state.spawnRate = 3000;
    if (state.difficulty === 'medium') state.spawnRate = 2500;
    if (state.difficulty === 'hard') state.spawnRate = 1800;
}

// --- SOCKET LOGIC ---
// --- SOCKET LOGIC ---
if(socket) {
    socket.on('connect', () => { 
        console.log("🟢 Socket Connected to Server! ID:", socket.id);
        // Force register kapag may nakitang user data
        if (typeof currentUser !== 'undefined' && currentUser && currentUser.uid) {
            socket.emit('register_player', { name: currentUser.username || myName, uid: currentUser.uid }); 
            console.log("📡 UID sent to server:", currentUser.uid);
        }
    });

    // 📢 GLOBAL BROADCASTER LISTENER
    socket.on('receive_global_msg', (data) => {
        const announcer = document.getElementById("global-announcer");
        const textObj = document.getElementById("announcer-text");
        
        if (announcer && textObj) {
            textObj.innerText = data.text;
            textObj.style.color = data.color || '#fff';
            announcer.classList.remove("hidden");
            
            // Play Epic Siren Sound
            if(window.Sound) {
                window.Sound.playTone(300, 'square', 0.5);
                setTimeout(() => window.Sound.playTone(400, 'square', 0.5), 500);
            }

            // Hide after 10 seconds
            setTimeout(() => {
                announcer.classList.add("hidden");
            }, 10000);
        }
    });
    // 1. VS MODE STATE SYNC
    socket.on('receive_vs_state', (oppState) => { 
        if (state.gameMode === 'vs') {
            state.opponentState = oppState; 
            
            // 🚨 FIX: Auto-Detect Win Condition (0 HP Spy)
            if (state.isPlaying && !state.isPaused && !state.matchConcluded && oppState.health <= 0) {
                gameVictory("OPPONENT ELIMINATED");
            }
        } 
    });

    // 2. PLAYER DISCONNECT HANDLING
    socket.on('opponent_left', () => { 
        if (state.gameMode === 'vs') {
            // 🚨 FIX: Prevent Fake Victory if game is already over
            if (state.isPlaying) {
                gameVictory("OPPONENT DISCONNECTED"); 
            }
        } else {
            // Party Mode Fallback
            totalPlayers = Math.max(1, totalPlayers - 1); 
            state.floatingTexts.push({
                x: window.canvas.width / 2, 
                y: window.canvas.height / 2, 
                text: "ALLY SIGNAL LOST. SOLO MODE ENGAGED.", 
                color: "orange", 
                life: 4.0 
            });
            if(window.Sound) window.Sound.speak("Ally disconnected. Adjusting protocols.");
        }
    });

    // 3. PARTY MODE: SPAWN SYNC
    socket.on('sync_spawn', (data) => {
        if (state.gameMode === 'party' && !isHost && state.isPlaying) {
            state.meteors.push(data); 
        }
    });

    // 🟢 STUDENT LISTENS FOR TEACHER'S "GOD POWERS"
    socket.on('teacher_command', (data) => {
        let myId = window.myDocId || (currentUser ? currentUser.uid : window.myName);
        
        if (data.targetUid === myId) {
            if (data.command === 'freeze') {
                if (typeof triggerInputLock === "function") triggerInputLock(); // Lock the input!
                state.floatingTexts.push({ x: window.canvas.width/2, y: window.canvas.height/2, text: "TERMINAL JAMMED BY CMDR", color: "#ff0055", life: 3.0 });
                if(window.Sound) window.Sound.error();
            } 
            else if (data.command === 'supply') {
                // Spawn a supply crate falling directly to this student!
                let supplyMeteor = { 
                    id: "SUPPLY-" + Math.random(), 
                    x: window.canvas.width / 2, 
                    y: -50, 
                    question: "CMDR GIFT", answer: 0, 
                    vx: 0, vy: 0, speed: 0.5, radius: 60, 
                    isSupply: true, isBoss: false, hp: 1, maxHp: 1 
                };
                state.meteors.push(supplyMeteor);
                state.floatingTexts.push({ x: window.canvas.width/2, y: window.canvas.height/2 - 100, text: "INCOMING BACKUP!", color: "#ffd700", life: 3.0 });
                if(window.Sound) window.Sound.powerup();
            }
        }
    });

    // 4. PARTY MODE: SHOT VISUALS
    socket.on('sync_shot', (data) => {
        if (state.isPlaying && state.gameMode === 'party') {
            let tx = getTurretX(data.pIndex, data.totalP);
            state.lasers.push({ x1: tx, y1: window.canvas.height, x2: data.tx, y2: data.ty, life: 1.0, isAlly: true });
            
            let idx = state.meteors.findIndex(m => m.id === data.targetId);
            if(idx !== -1) {
                let m = state.meteors[idx];
                if(m.isSupply) createParticles(m.x, m.y, "gold", 40);
                else if(m.isBoss) createParticles(m.x, m.y, "red", 50);
                else createParticles(m.x, m.y, "#00e5ff", 20);
                
                m.hp--; 
                if(m.hp <= 0) state.meteors.splice(idx, 1);
            }
        }
    });

    // 5. PARTY MODE: LEVEL UP SYNC
    socket.on('sync_level_update', (data) => {
        if (state.gameMode === 'party' && !isHost) {
            state.level = data.level;
            state.xp = 0; 
            state.spawnRate = Math.max(800, 2500 - (state.level * 150));
            triggerLevelUpVisuals();
        }
    });
    
    // 6. PARTY MODE: XP & SCORE SYNC (HOST SIDE)
    socket.on('client_xp_gain', (data) => {
        if (state.gameMode === 'party' && isHost) {
            state.xp += data.amount; 
            state.score += data.amount; // 🟢 Add score locally to host
            checkLevelUp(); 
            updateHUD();
            
            // Broadcast back updated Total XP AND Score
            socket.emit('host_sync_xp', { room: currentRoomId, xp: state.xp, maxXp: state.xpToNext, sharedScore: state.score });
        }
    });

    // 7. PARTY MODE: XP & SCORE SYNC (CLIENT SIDE)
    socket.on('sync_xp_update', (data) => {
        if (state.gameMode === 'party' && !isHost) {
            state.xp = data.xp;
            state.xpToNext = data.maxXp; 
            if (data.sharedScore !== undefined) state.score = data.sharedScore; // 🟢 Sync exact team score!
            updateHUD(); 
        }
    });

    // 4. PARTY MODE: SHOT VISUALS (Aayusin natin ang pinanggagalingan ng baril ng kakampi)
    socket.on('sync_shot', (data) => {
        if (state.isPlaying && state.gameMode === 'party') {
            let tx = getTurretX(data.pIndex, data.totalP);
            // 🟢 FIX: Itaas ng 220 pixels ang laser ng kakampi para sa baril manggaling!
            state.lasers.push({ x1: tx, y1: window.canvas.height - 220, x2: data.tx, y2: data.ty, life: 1.0, isAlly: true });
            
            let idx = state.meteors.findIndex(m => m.id === data.targetId);
            if(idx !== -1) {
                let m = state.meteors[idx];
                if(m.isSupply) createParticles(m.x, m.y, "gold", 40);
                else if(m.isBoss) createParticles(m.x, m.y, "red", 50);
                else createParticles(m.x, m.y, "#00e5ff", 20);
                
                m.hp--; 
                if(m.hp <= 0) state.meteors.splice(idx, 1);
            }
        }
    });
    // 8. SKILLS & EXTRAS
    socket.on('sync_skill', (data) => {
        if (state.gameMode === 'party' && state.isPlaying) {
            if (data.type === 'EMP') triggerEMP(true, true); 
            if (data.type === 'SLOW') triggerSlowMo(true, true);
        }
    });

    // 🟢 THE PANOPTICON INTERCEPTOR (Alerting the Student)
    socket.on('request_stream', (data) => {
        let myId = window.myDocId || (currentUser ? currentUser.uid : window.myName);
        
        if (data.targetUid === myId) {
            window.isBeingWatched = true; 
            console.log("⚠️ CAUTION: Commander is viewing your terminal.");
            if(window.Sound) window.Sound.playTone(800, 'square', 0.1); // Beep
            
            // Show Alert
            const alertBox = document.getElementById("panopticon-alert");
            if(alertBox) alertBox.classList.add("active");
        }
    });

    socket.on('stop_stream', (data) => {
        let myId = window.myDocId || (currentUser ? currentUser.uid : window.myName);
        if (data.targetUid === myId) {
            window.isBeingWatched = false; 
            console.log("✅ CLEAR: Surveillance disconnected.");
            
            // Hide Alert
            const alertBox = document.getElementById("panopticon-alert");
            if(alertBox) alertBox.classList.remove("active");
        }
    });

    socket.on('receive_spy_frame', (data) => {
        if (state.gameMode === 'classroom' && isHost) {
            if (window.currentWatchTarget === data.uid) {
                const camImage = document.getElementById("live-cctv-screen");
                const loadText = document.getElementById("cctv-loading-text");
                if (camImage) {
                    camImage.src = data.frame; // IPAPAKITA ANG VIDEO NG BATA!
                    if(loadText) loadText.style.display = 'none'; 
                }
            }
        }
    });
    // 9. PARTY MODE: POSITION SYNC (ANTI-DESYNC)
    socket.on('party_sync_pos', (data) => {
        if (state.gameMode === 'party' && !isHost && state.isPlaying) {
            data.pos.forEach(p => {
                let localMeteor = state.meteors.find(m => m.id === p.id);
                if (localMeteor) {
                    // Smooth correction: Hilaan ng konti papunta sa true position
                    localMeteor.y = (localMeteor.y + p.y) / 2; 
                    localMeteor.x = p.x;
                }
            });
        }
    });


        
    socket.on('update_leaderboard', (list) => { updateSideLeaderboard(list); });
    socket.on('opponent_died', () => { gameVictory("OPPONENT NEUTRALIZED"); });
}

async function fetchTopAgents() {
    try {
        const q = query(collection(db, "scores"), orderBy("score", "desc"), limit(5));
        const snap = await getDocs(q); 
        let list = [];
        snap.forEach(d => list.push(d.data()));
        updateSideLeaderboard(list);
    } catch(e) { console.log("Offline/Error", e); }
}

function updateSideLeaderboard(list) {
    const el = document.getElementById("leaderboard-list");
    if(el) {
        el.innerHTML = ""; 
        list.forEach((p, i) => { 
            let name = p.name || "Agent";
            let score = p.score || 0;
            let color = (p.name === myName || p.id === socket?.id) ? "#00e5ff" : "white"; 
            el.innerHTML += `<li class="player-row" style="color:${color}; display:flex; justify-content:space-between; margin-bottom:5px; text-align: left;"><span>#${i+1} ${name}</span><span style="color:#fca311">${score}</span></li>`; 
        });
    }
}

window.toggleMute = function() { let m = window.Sound.toggle(); document.getElementById("mute-btn").innerText = m ? "🔇" : "🔊"; };
window.togglePause = function() { 
    // 🚨 SECURITY CHECK: Kung naka-freeze ng Teacher, bawal mag-resume!
    if (state.isGlobalFreeze) {
        if(window.Sound) window.Sound.error();
        // Force show pause modal ulit kung sinubukan i-close
        document.getElementById("pause-modal").classList.remove("hidden");
        return; 
    }

    if(!state.isPlaying) return; 
    
    state.isPaused = !state.isPaused; 
    
    let m = document.getElementById("pause-modal"); 
    let title = document.getElementById("pause-title");
    let btn = document.getElementById("btn-resume-game");

    if(state.isPaused) { 
        m.classList.remove("hidden"); 
        
        // Update texts
        if(title) title.innerText = "SYSTEM PAUSED";
        if(btn) btn.style.display = "block"; 
        
        if(window.inputField) window.inputField.blur(); 
    } else { 
        m.classList.add("hidden"); 
        if(window.inputField) window.inputField.focus(); 
        state.lastTime = performance.now(); 
        window.gameLoopId = requestAnimationFrame(gameLoop);
    } 
};

window.validateName = function() {
    if (typeof currentUser !== 'undefined' && currentUser) return true;
    const nameInput = document.getElementById("my-name");
    if (!nameInput) return false;
    const nameVal = nameInput.value.trim();
    
    if (!nameVal) {
        if(window.Sound) window.Sound.error();
        const container = document.getElementById("name-container");
        if(container) { container.style.animation = "none"; container.offsetHeight; container.style.animation = "shake 0.5s"; }
        nameInput.style.borderColor = "#ff0055"; setTimeout(() => { nameInput.style.borderColor = "#333"; }, 500);
        return false;
    }
    
    myName = nameVal; 
    
    // 🟢 FIX: Send correct object format so Backend knows your UID!
    if(socket) {
        if (currentUser && currentUser.uid) {
            socket.emit('register_player', { name: myName, uid: currentUser.uid });
        } else {
            socket.emit('register_player', myName); 
        }
    }
    return true;
};

// --- GAME LOGIC STARTERS ---
window.showMultiplayerMenu = function() { if(!window.validateName()) return; window.Sound.click(); document.getElementById("start-modal").classList.add("hidden"); document.getElementById("mp-menu-modal").classList.remove("hidden"); };
window.startSolo = function() { if(!window.validateName()) return; pendingGameMode = 'solo'; window.openMissionConfig(); };
window.createRoom = async function() {
    if(!window.validateName()) return;

    // FIX: Capture the radio button value (vs or party)
    const modeEl = document.querySelector('input[name="game-mode"]:checked');
    pendingGameMode = modeEl ? modeEl.value : 'vs'; // Default to vs if nothing selected
    
    window.openMissionConfig(); 
};

window.openMissionConfig = function() {
    document.getElementById("start-modal").classList.add("hidden");
    document.getElementById("mp-menu-modal").classList.add("hidden");
    document.getElementById("mission-config-modal").classList.remove("hidden");
};
// --- NAVIGATION & ABORT LOGIC ---

window.cancelMission = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("mission-config-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.remove("hidden");
    
    // 🟢 Ipakita ulit ang Orbs kung galing sa game prep
    if(window.updateOrbsVisibility) window.updateOrbsVisibility();
};



window.cleanupGame = function() {
    document.body.classList.remove("overdrive-active");
    state.isOverdrive = false;
    document.body.classList.remove('in-combat');

    if (window.gameLoopId) {
        cancelAnimationFrame(window.gameLoopId);
        window.gameLoopId = null;
    }
    
    // 🟢 THE FIX: Ipakita ulit ang DALAWANG orbs kapag tapos na ang laban o bumalik sa menu/lobby
    const nexusBtn = document.getElementById("jessbot-toggle-btn");
    const commsBtn = document.getElementById("comms-toggle-btn");
    if (nexusBtn) nexusBtn.style.display = "flex";
    if (commsBtn) commsBtn.style.display = "flex"; 

    console.log("🧹 Executing Deep System Cleanup...");
    
    // 1. Stop Game Loop & Logic
    state.isPlaying = false;
    state.isPaused = false;
    state.isGlobalFreeze = false;
    
    // 2. Kill ALL Zombie Timers
    if (typeof scoreInterval !== 'undefined' && scoreInterval) clearInterval(scoreInterval);
    if (state.gameTimer) clearInterval(state.gameTimer);
    if (state.lockTimer) clearInterval(state.lockTimer);
    if (state.vsInterval) clearInterval(state.vsInterval);
    if (state.partySyncInterval) clearInterval(state.partySyncInterval);
    if (state.petAttackTimer) clearInterval(state.petAttackTimer);
    if (autoStartTimer) clearInterval(autoStartTimer);
    
    // 3. Detach Database Listeners (ONLY if not in class)
    if (state.gameMode !== 'classroom') {
        if (roomUnsub) { roomUnsub(); roomUnsub = null; }
        if (typeof dashboardUnsub !== 'undefined' && dashboardUnsub) { dashboardUnsub(); dashboardUnsub = null; }
    }

   
    
    // 🟢 CRITICAL FIX: DO NOT CLEAR currentRoomId OR myDocId HERE!
    // Hayaan silang naka-save para makapagpadala pa rin ng data kay Teacher.
    state.matchConcluded = false; 
};

window.abortStudent = function() {
    if(confirm("Disconnect from Classroom?")) {
        window.goHome(true); // Ipasa ang 'true' para hindi na magtanong ulit!
    }
};
window.confirmMission = async function() {

    const btn = document.querySelector(".launch-btn");
    if (btn) {
        if (btn.disabled) return; 
        btn.disabled = true;
        btn.innerText = "⏳ SECURING CONNECTION...";
    }
    // 1. Capture Settings
    state.selectedOps = [];
    if(document.getElementById('op-add').checked) state.selectedOps.push('+');
    if(document.getElementById('op-sub').checked) state.selectedOps.push('-');
    if(document.getElementById('op-mul').checked) state.selectedOps.push('x');
    if(document.getElementById('op-div').checked) state.selectedOps.push('÷');
    if(document.getElementById('op-alg').checked) state.selectedOps.push('Alg');
    
    if(state.selectedOps.length === 0) state.selectedOps.push('+');

    let diffEl = document.querySelector('input[name="diff-select"]:checked');
    state.difficulty = diffEl ? diffEl.value : 'medium';

    // 2. Start Game Logic
    if (pendingGameMode === 'solo') {
        state.gameMode = 'solo';
        document.getElementById("mission-config-modal").classList.add("hidden");
        startGameLogic();
    } 
    // CHANGE: Added 'vs' to the condition
    else if (pendingGameMode === 'party' || pendingGameMode === 'vs') {
        try {
            // CHANGE: Use the variable instead of hardcoding 'party'
            state.gameMode = pendingGameMode; 
            
            const code = Math.random().toString(36).substring(2,6).toUpperCase();
            currentRoomId = code; 
            isHost = true; 
            myPlayerIndex = 0; 
            totalPlayers = 1;
            
            await setDoc(doc(db, "rooms", code), { 
                host: myName, 
                players: [{name: myName}], 
                gameState: 'waiting', 
                mode: state.gameMode, // Saves 'vs' or 'party' correctly to DB
                settings: { ops: state.selectedOps, diff: state.difficulty }
            });
            
            document.getElementById("mission-config-modal").classList.add("hidden");
            enterLobbyUI(code);
            
            if(socket) socket.emit('join_room', { room: code, name: myName });
        } catch(e) { alert("Error: " + e.message); }
    }
};




function enterClassroomLobby(code, roomName) {
    // 1. UI Setup: Ihanda ang Lobby Screen
    document.getElementById("mp-menu-modal").classList.add("hidden");
    document.getElementById("lobby-modal").classList.remove("hidden");
    document.getElementById("room-code-display").innerText = roomName || code;
    
    setTimeout(() => {
        window.toggleCurtain(false);
    }, 1500);

    const lobbyTitle = document.getElementById("lobby-title-text");
    if(lobbyTitle) lobbyTitle.innerText = "CLASSROOM STANDBY";
    
    const waitMsg = document.getElementById("client-wait-msg");
    if(waitMsg) {
        waitMsg.classList.remove("hidden");
        waitMsg.innerText = "EYES ON THE TEACHER...";
    }
    
    const hostBtn = document.getElementById("host-start-btn");
    if(hostBtn) hostBtn.classList.add("hidden");

    // 2. Clear Old Listeners
    if (roomUnsub) roomUnsub();
    
    // 3. START LISTENING TO ROOM UPDATES
    roomUnsub = onSnapshot(doc(db, "rooms", code), (snap) => {
        if(!snap.exists()) {
            alert("Classroom disbanded by the Teacher.");
            window.goHome();
            return;
        }
        
        const data = snap.data();

        // A. SYNC CONFIG
        if(data.config) {
            if(data.config.ops) state.selectedOps = data.config.ops;
            state.classroomTopic = data.config.topic || 'custom';
            state.customTimeLimit = data.config.timeLimit; 
            
            // 🟢 FORCE SYNC DIFFICULTY
            state.difficulty = data.config.difficulty || 'medium';
            
            // Re-apply spawn rates based on the new difficulty immediately
            if (state.difficulty === 'easy') state.spawnRate = 3000;
            else if (state.difficulty === 'hard') state.spawnRate = 1800;
            else state.spawnRate = 2500;
        }

        // B. STATE MACHINE
        switch (data.status) {
            
            // --- CASE 1: GAME IS ACTIVE ---
            case 'playing':
                // Check 1: Resume from Freeze
                if (state.isGlobalFreeze) {
                    console.log("🔓 Unfreezing System...");
                    state.isGlobalFreeze = false;
                    state.isPaused = false;
                    document.getElementById("pause-modal").classList.add("hidden");
                    
                    if (window.inputField) window.inputField.focus();
                    
                    // 🛡️ THE LOCK: Paandarin lang ang makina kung patay talaga
                    if (!window.gameLoopId) {
                        state.lastTime = performance.now(); // Reset time to prevent massive jump
                        window.gameLoopId = requestAnimationFrame(gameLoop);
                    }
                    return; 
                }
                // Check 2: New Round Detection
                if (!state.isPlaying || state.roundsPlayed !== data.currentRound) {
                    console.log("🚀 Starting Round:", data.currentRound);
                    
                    // 1. ACTIVATE THE CURTAIN (Cover everything!)
                    const curtain = document.getElementById("class-curtain");
                    const curtainText = document.getElementById("curtain-countdown");
                    
                    curtain.classList.remove("hidden");
                    curtain.style.display = "flex"; // Force flex display
                    
                    // 2. Hide Menus (Behind the curtain)
                    document.getElementById("start-modal").classList.add("hidden"); 
                    document.getElementById("lobby-modal").classList.add("hidden");
                    document.getElementById("report-modal").classList.add("hidden");
                    document.getElementById("mp-menu-modal").classList.add("hidden");
                    document.getElementById("profile-section").classList.add("hidden"); // Hide profile explicitly
                    
                    // 3. Reset State Logic
                    if (typeof scoreInterval !== 'undefined') clearInterval(scoreInterval);
                    if (state.gameTimer) clearInterval(state.gameTimer);
                    
                    state.gameMode = 'classroom'; 
                    state.roundsPlayed = data.currentRound || 1; 

                    if (state.roundsPlayed === 1) {
                        state.score = 0;
                        state.mistakes = []; 
                        state.gameHistory = [];
                    }

                    state.health = 100;      
                    state.meteors = [];
                    state.lasers = [];
                    state.particles = [];

                    // 4. THE COUNTDOWN SEQUENCE
                    let count = 3;
                    curtainText.innerText = count;
                    if(window.Sound) window.Sound.click();

                    let startTimer = setInterval(() => {
                        count--;
                        if (count > 0) {
                            curtainText.innerText = count;
                            if(window.Sound) window.Sound.click();
                        } else if (count === 0) {
                            curtainText.innerText = "ENGAGE!";
                            curtainText.style.color = "#ff0055"; 
                            if(window.Sound) window.Sound.powerup();
                        } else {
                            // 5. START GAME & LIFT CURTAIN
                            clearInterval(startTimer);
                            curtain.classList.add("hidden"); 
                            
                            // 🟢 FIX 1: Ensure Canvas wrapper is visible FIRST
                            const gameWrapper = document.getElementById("game-wrapper");
                            gameWrapper.classList.remove("hidden");
                            gameWrapper.style.display = "block"; // Force display
                            
                            // 🟢 FIX 2: FORCE RECALCULATE RESOLUTION NOW THAT IT'S VISIBLE!
                            setTimeout(() => {
                                window.fixGameResolution();
                                startGameLogic(); // Start the engine
                                reportProgress(false); 
                            }, 50); // Small 50ms delay lets the browser render the DOM first
                        }
                    }, 1000);
                }
                break;
            
            // --- CASE 2: TEACHER FROZE THE GAME ---
            case 'frozen':
                if (state.isPlaying && !state.isPaused) {
                    state.isPaused = true;
                    state.isGlobalFreeze = true;
                    
                    const pModal = document.getElementById("pause-modal");
                    pModal.classList.remove("hidden");
                    
                    const pTitle = document.querySelector("#pause-modal h2");
                    if(pTitle) {
                        pTitle.innerText = "⚠️ FROZEN BY COMMANDER";
                        pTitle.style.color = "#ff0055";
                    }
                    
                    const resBtn = document.getElementById("btn-resume-game");
                    if(resBtn) resBtn.style.display = 'none';

                    if(window.inputField) window.inputField.blur();
                    if(window.Sound) window.Sound.error();
                }
                break;

            // --- CASE 3: ROUND ENDED (INTERMISSION) ---
            case 'round_ended':
                // 🟢 Kung buhay pa ang laro nang i-stop ni teacher, tawagin ang gameOver!
                if (state.isPlaying) {
                    gameOver();
                } else {
                    // Kung nasa game over screen na, i-update lang ang status
                    if(typeof window.reportProgress === 'function') window.reportProgress(false);
                }
                
                state.isPlaying = false;
                if(window.inputField) window.inputField.blur();
                
                const rTitle = document.querySelector("#report-modal h1");
                if(rTitle) { rTitle.innerText = "ROUND COMPLETE"; rTitle.className = "neon-blue"; }
                if(window.Sound) window.Sound.speak("Round complete. Stand by.");
                break;

            // --- CASE 4: CLASS DISMISSED (FINAL SCORE) ---
            case 'finished':
                if (state.isPlaying) gameOver();
                
                state.isPlaying = false;
                
                const fTitle = document.querySelector("#report-modal h1");
                if(fTitle) {
                    fTitle.innerText = "MISSION ACCOMPLISHED";
                    fTitle.className = "neon-gold";
                }
                
                // Bigyan na sila ng button para makaalis
                const fExitBtn = document.querySelector(".retry-actions");
                if(fExitBtn) {
                    fExitBtn.innerHTML = `<button class="btn primary" onclick="window.goHome()">LOGOUT AGENT</button>`;
                }

                if(typeof window.reportProgress === 'function') window.reportProgress(true); 
                if(window.Sound) window.Sound.speak("Class dismissed. Good work, Agent.");
                break;
        }
    });

    
}

// 🟢 HELPER: TOGGLE CYBER CURTAIN
window.toggleCurtain = function(show, title = "LOADING...", sub = "PLEASE WAIT", showCount = false) {
    const curtain = document.getElementById("class-curtain");
    const titleEl = document.getElementById("curtain-title");
    const subEl = document.getElementById("curtain-sub");
    const countEl = document.getElementById("curtain-countdown");
    const loader = document.querySelector(".loader-ring");

    if (show) {
        curtain.classList.remove("hidden");
        curtain.style.display = "flex";
        titleEl.innerText = title;
        subEl.innerText = sub;
        
        if (showCount) {
            countEl.classList.remove("hidden");
            loader.classList.add("hidden"); // Hide spinner during countdown
        } else {
            countEl.classList.add("hidden");
            loader.classList.remove("hidden"); // Show spinner during loading
        }
    } else {
        curtain.classList.add("hidden");
    }
};

function enterLobbyUI(code) {
    // 🟢 BUG FIX 1: ITAAS ANG CURTAIN PARA MAKITA ANG LOBBY!
    if (window.toggleCurtain) window.toggleCurtain(false);

    document.getElementById("mp-menu-modal").classList.add("hidden"); 
    document.getElementById("lobby-modal").classList.remove("hidden");
    document.getElementById("room-code-display").innerText = code;
    
    let titleEl = document.getElementById("lobby-title-text");
    if(titleEl) titleEl.innerText = state.gameMode === 'party' ? "TEAM LOBBY" : "VS LOBBY";
    
    if(isHost) {
        document.getElementById("host-start-btn").classList.remove("hidden"); 
        document.getElementById("client-wait-msg").classList.add("hidden");
    } else {
        document.getElementById("host-start-btn").classList.add("hidden");
        document.getElementById("client-wait-msg").classList.remove("hidden");
    }

    roomUnsub = onSnapshot(doc(db, "rooms", code), (snap) => {
        if(!snap.exists()) return;
        let data = snap.data(); 
        totalPlayers = data.players.length; 
        
        let list = document.getElementById("lobby-players"); 
        if(list) { 
            list.innerHTML=""; 
            data.players.forEach(p => list.innerHTML += `<div class="lobby-player-row"><span>${p.name}</span></div>`); 
        }
        
        // 🟢 PREVENT DOUBLE START BUG
        if(data.gameState === 'playing' && !state.isPlaying) {
            startGameLogic();
        }
    });
}
window.hostStartGame = async function() { if(totalPlayers < 2) { alert("Need 2 players!"); return; } await updateDoc(doc(db, "rooms", currentRoomId), { gameState: 'playing' }); };

function startGameLogic() {
    // 1. CLEANUP FIRST
    window.cleanupGame(); // Guarantee no overlapping frames or intervals

    // 2. Reset Visuals
    state.combo = 0; state.maxCombo = 0;
    const comboEl = document.getElementById("combo-container");
    if(comboEl) comboEl.classList.add("hidden");

    if (!window.canvas) window.canvas = document.getElementById("gameCanvas");
    if (!window.ctx && window.canvas) window.ctx = window.canvas.getContext("2d");

    // 3. START GAMEPLAY
    beginGameplay();

    // --- MULTIPLAYER LOGIC INJECTIONS (DE-DUPLICATED) ---
    
    // A. VS MODE: NETWORK OPTIMIZATION (Strict 100ms Tick Rate)
    if(state.gameMode === 'vs' && socket && currentRoomId) {
        if(state.vsInterval) clearInterval(state.vsInterval);
        state.vsInterval = setInterval(() => {
            if(state.isPlaying && !state.isPaused && !state.matchConcluded) {
                let simpleMeteors = state.meteors.map(m => ({ 
                    id: m.id, x: Math.round(m.x), y: Math.round(m.y), q: m.question, hp: m.hp, 
                    radius: m.radius, isGolden: m.isGolden, isSupply: m.isSupply, isBoss: m.isBoss 
                }));

                let simpleLasers = state.lasers.map(l => ({ 
                    x1: Math.round(l.x1), y1: Math.round(l.y1), x2: Math.round(l.x2), y2: Math.round(l.y2), color: l.color 
                }));

                socket.emit('send_vs_state', { 
                    room: currentRoomId, 
                    state: { 
                        meteors: simpleMeteors, 
                        lasers: simpleLasers, 
                        health: state.health, 
                        score: state.score 
                    } 
                });
            }
        }, 100); // 10 FPS sync rate - Perfect for smooth rendering without lagging the server!
    }

    // B. PARTY MODE: HOST SYNC PULSE
    if(state.gameMode === 'party' && isHost && socket) {
        if(state.partySyncInterval) clearInterval(state.partySyncInterval);
        state.partySyncInterval = setInterval(() => {
            if(state.isPlaying && !state.isPaused && state.meteors.length > 0) {
                let positions = state.meteors.map(m => ({ id: m.id, y: m.y, x: m.x }));
                socket.emit('host_sync_pos', { room: currentRoomId, pos: positions });
            }
        }, 2000); 
    }
}

window.beginGameplay = function() {
    
    document.body.classList.remove('classroom-mode'); 
    document.body.classList.remove('dashboard-active'); 
    document.body.classList.add('in-combat'); 
    
    document.querySelectorAll('.modal, #teacher-dashboard, #start-modal, #class-selection-modal, #report-modal, #win-modal').forEach(el => {
        if(el) el.classList.add('hidden');
    });

    if(window.updateOrbsVisibility) window.updateOrbsVisibility(true);
    const gameWrapper = document.getElementById("game-wrapper");
    if(gameWrapper) {
        gameWrapper.classList.remove("hidden");
        gameWrapper.style.display = "block";
        gameWrapper.style.zIndex = "10"; 
    }

    // 🟢 BUG FIX 1: I-force update ang resolution bago gumawa ng elements!
    window.fixGameResolution();

    const nexusBtn = document.getElementById("jessbot-toggle-btn");
    const commsBtn = document.getElementById("comms-toggle-btn");
    if (nexusBtn) nexusBtn.style.display = "none";
    if (commsBtn) commsBtn.style.display = "none"; 
    
    const nexusSidebar = document.getElementById("jessbot-sidebar");
    if (nexusSidebar && !nexusSidebar.classList.contains("closed")) {
        nexusSidebar.classList.add("closed");
    }

    // --- 🐾 INITIALIZE PET POWERS PARA SA LABAN ---
    let myPet = window.getCurrentPet();
    state.petData = { shieldCharges: 0 };
    
    if (myPet) {
        if (myPet.id === 'pet_c2') state.petData.shieldCharges = 1; 
        if (myPet.id === 'pet_e1') state.petData.shieldCharges = 3; 
        if (myPet.id === 'pet_m2') state.petData.shieldCharges = 999; 

        if (myPet.id === 'pet_m1') {
            if (state.petAttackTimer) clearInterval(state.petAttackTimer);
            state.petAttackTimer = setInterval(() => {
                if(state.isPlaying && !state.isPaused) window.petAutoFire();
            }, 5000);
        }
    }

    // 🔊 VOICE PROMPTS & AUDIO
    if (state.gameMode === 'classroom') {
        if(window.Sound) window.Sound.speak("Live Assessment Started. Commander is monitoring.");
    } else {
        if (window.Sound) window.Sound.speak(state.gameMode === 'vs' ? "Versus Mode!" : "Mission Start!");
    }

    if (window.Sound) {
        window.Sound.init();
        window.Sound.playBGM('battle'); // 🟢 BGM TRIGGER
    }
    
    state.isPlaying = true; 
    state.isPaused = false; 
    state.matchConcluded = false; // Reset the lock
    
    // 🚨 RESET SCORE ONLY (Huwag i-reset ang coins!)
    if(state.gameMode !== 'classroom' || state.roundsPlayed === 1) { 
        state.score = 0; 
        state.mistakes = []; 
        state.gameHistory = []; 
    }
    
    // 🚨 LOAD UPGRADE STATS
    if (window.applyUpgradeStats) {
        window.applyUpgradeStats(); 
    } else {
        state.health = 100; 
    }

    state.level = 1; state.xp = 0; state.xpToNext = 50; 
    
    // ✅ PHASE 3.5: CUSTOM TIMER SETUP (FIXED ZOMBIE TIMER)
    if (state.gameMode === 'classroom') {
        state.timeRemaining = state.customTimeLimit || 120; 
        
        if(state.gameTimer) clearInterval(state.gameTimer);
        state.gameTimer = setInterval(() => {
            if(!state.isPaused && state.isPlaying && !state.isGlobalFreeze) {
                state.timeRemaining--;
                if(window.updateHUD) window.updateHUD();
                
                if(state.timeRemaining <= 0) {
                    clearInterval(state.gameTimer);
                    state.timeRemaining = 0; // Lock at zero
                    
                    // 🟢 FIX: TAWAGIN ANG GAMEOVER PARA LUMABAS ANG DEBRIEF SCREEN!
                    state.floatingTexts.push({ x: window.canvas.width/2, y: window.canvas.height/2, text: "TIME UP! SECURING DATA...", color: "#ffd700", life: 3.0 });
                    
                    setTimeout(() => {
                        window.gameOver(); // Trigger screen transition
                    }, 1000);
                }
            }
        }, 1000);
    }

    if (state.difficulty === 'easy') state.spawnRate = 3000;
    else if (state.difficulty === 'hard') state.spawnRate = 1800;
    else state.spawnRate = 2500;

    state.bossActive = false; state.bossData = null;
    state.meteors = []; state.lasers = []; state.particles = []; state.floatingTexts = []; state.shockwaves = [];
    state.opponentState = { meteors: [], lasers: [], health: 100, score: 0 };
    
    if (!cityLoaded && window.generateCity) generateCity();
    if (window.initStars) initStars();
    
    if(window.inputField) { window.inputField.value = ""; window.inputField.focus(); }
    if(window.updateHUD) window.updateHUD();
    
    state.lastTime = performance.now(); state.spawnTimer = performance.now();
    if(window.fetchTopAgents) fetchTopAgents();

    if(state.gameMode === 'solo' || isHost || state.gameMode === 'vs') { spawnMeteor(0,0,false); }
    
    // VS MODE SYNC
    if(state.gameMode === 'vs' && socket && currentRoomId) {
        if(state.vsInterval) clearInterval(state.vsInterval);
        state.vsInterval = setInterval(() => {
            if(state.isPlaying && !state.isPaused && !state.matchConcluded) {
                let simpleMeteors = state.meteors.map(m => ({ 
                    id: m.id, x: m.x, y: m.y, q: m.question, hp: m.hp, 
                    radius: m.radius, isGolden: m.isGolden, goldenLife: m.goldenLife,
                    isSupply: m.isSupply, isBoss: m.isBoss, isSummoned: m.isSummoned 
                }));

                let simpleLasers = state.lasers.map(l => ({ 
                    x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, color: l.color 
                }));

                socket.emit('send_vs_state', { 
                    room: currentRoomId, 
                    state: { 
                        meteors: simpleMeteors, 
                        lasers: simpleLasers, 
                        health: state.health, 
                        score: state.score 
                    } 
                });
            }
        }, 100); 
    }

    // 🟢 TEACHER TELEMETRY SYNC (Bawat 2 segundo mag-uupdate kay Teacher)
    if (state.gameMode === 'classroom') {
        if (typeof scoreInterval !== 'undefined' && scoreInterval) clearInterval(scoreInterval);
        scoreInterval = setInterval(() => {
            if (typeof window.reportProgress === 'function') window.reportProgress(false);
        }, 2000); 
    }
    
    requestAnimationFrame(gameLoop);
};

// Aliasing the global function just in case older code calls it directly
function beginGameplay() { window.beginGameplay(); }

function spawnMeteor(x, y, isBossSource) {
    if (state.bossActive && !isBossSource) return;

    // --- BOSS SPAWN LOGIC ---
    let isCampaignBossTime = (state.gameMode === 'campaign' && Math.floor(state.score / 10) >= 10);
    let isEndlessBossTime = (state.gameMode !== 'campaign' && state.level % 5 === 0 && state.level > 1);

    if ((isCampaignBossTime || isEndlessBossTime) && !state.bossActive && !isBossSource) {
        state.bossActive = true;
        
        // Mas makunat ang boss sa mataas na chapter
        let baseHp = state.gameMode === 'campaign' ? state.currentCampaignLevel : state.level;
        let bossHP = 10 + Math.floor(baseHp * 2); 
        
        let bossQ = generateMath(true); 
        let bossX = (state.gameMode === 'vs') ? (window.canvas.width / 4) : (window.canvas.width / 2);
        let bossSkinID = (state.equipped && state.equipped.boss) ? state.equipped.boss : 'boss_def';

        let mData = {
            id: "BOSS-" + Math.random(),
            x: bossX, y: -400, 
            question: bossQ.q, answer: bossQ.a,
            speed: 0.5, radius: 180, rot: 0, 
            isBoss: true, hp: bossHP, maxHp: bossHP,
            lastSpawn: 0, isEntering: true,
            skin: bossSkinID 
        };
        
        if (window.initBossShield) window.initBossShield(mData);
        state.meteors.push(mData); 
        state.bossData = mData;
        
        if(window.Sound) {
            window.Sound.speak("Warning. Sector Guardian Approaching.");
            window.Sound.playTone(50, 'sawtooth', 1.0); 
        }
        
        if (state.gameMode === 'party' && isHost && socket) { 
            socket.emit('host_spawn', { room: currentRoomId, data: mData }); 
        }
        return;
    }

    // ... (Keep the rest of your normal NEMESIS & NORMAL SPAWN LOGIC intact) ...

    // --- NEMESIS & NORMAL SPAWN LOGIC ---
    let math;
    let isNemesis = false;

    // 🚨 NEMESIS CHECK: 40% Chance na lumabas ang dating mali (kung meron)
    if (state.nemesisList && state.nemesisList.length > 0 && Math.random() < 0.4) {
        // Pick a random mistake from the past
        let randomIndex = Math.floor(Math.random() * state.nemesisList.length);
        let nemesisQ = state.nemesisList[randomIndex];
        
        math = { q: nemesisQ.q, a: nemesisQ.a };
        isNemesis = true; // Mark as Nemesis
    } else {
        // Normal Math Generation
        math = generateMath(false);
    }

    let safePadding = 80;
    let spawnWidth = (state.gameMode === 'vs') ? (window.canvas.width / 2) - (safePadding * 2) : window.canvas.width - (safePadding * 2);
    let sx = isBossSource ? x : (Math.random() * spawnWidth) + safePadding;
    
    // Disable loot for Nemesis (Focus on survival)
    let lootChance = state.difficulty === 'easy' ? 0.20 : (state.difficulty === 'hard' ? 0.10 : 0.15);
    let isSupply = !isNemesis && (Math.random() < lootChance);

    let baseSpeed = 0.3; 
    if (state.difficulty === 'hard') baseSpeed = 0.5;
    let currentSpeed = Math.min(1.5, baseSpeed + (state.level * 0.02)); 
    
    let isSummoned = isBossSource;
    
    // 🟢 THE FIX: FORCE SOLO MODE PHYSICS
    // False na siya lagi para hindi mag-scatter ang kalaban at bumagsak sila ng deretso!
    let isSwarm = false; 
    let isGolden = (state.gameMode === 'classroom') && (Math.random() < 0.05); 
    
    let vx = 0;
    // Skins & Aura Setup
    let enemySkinID = (state.equipped && state.equipped.enemy) ? state.equipped.enemy : 'enemy_def';
    let fxId = (state.equipped && state.equipped.fx) ? state.equipped.fx : 'fx_blue';
    let fxObj = (typeof shopCatalog !== 'undefined') ? shopCatalog.fx.find(f => f.id === fxId) : null;
    let auraType = fxObj ? fxObj.aura : 'none';

    if (isSummoned) auraType = 'void'; 
    
    // 🚨 NEMESIS VISUALS: Fire Aura & Warning Sign
    if (isNemesis) {
        auraType = 'fire';
    }
    let displayQ = isNemesis ? "⚠️ " + math.q : math.q;

    // Sa loob ng spawnMeteor function, palitan ang linya ng radius:
    let mData = { 
        id: Math.random().toString(36).substr(2, 9), 
        x: sx, 
        y: isBossSource ? y : -100, // 🟢 FIX 2: Laging mag-uumpisa sa taas (-100)
        
        question: displayQ, 
        answer: math.a, 
        
        vx: vx, vy: 0, speed: currentSpeed, 
        isBoss: false, hp: 1, maxHp: 1, 
        isSupply: isSupply, isSummoned: isSummoned,
        isGolden: isGolden, goldenLife: 3.0,
        radius: 80, // 🟢 FIX 3: I-lock sa Normal Size ang mga barko

        skin: enemySkinID,
        aura: auraType,
        isNemesis: isNemesis 
    };

    if (isSummoned && window.createParticles) createParticles(sx, y, "red", 20);
    state.meteors.push(mData);
    
    if (state.gameMode === 'party' && isHost && socket) socket.emit('host_spawn', { room: currentRoomId, data: mData });
}

function findTarget(ans) {
    // 1. Check Boss Shield First (Highest Priority)
    if (state.bossActive && state.bossData && state.bossData.shield && state.bossData.shield.active) {
        if (state.bossData.shield.a === ans) return { type: 'shield', obj: state.bossData };
    }
    
    // 2. Find all meteors with the correct answer
    let matchingMeteors = state.meteors
        .map((m, index) => ({ meteor: m, originalIndex: index }))
        .filter(item => item.meteor.answer === ans);

    // 3. If matches exist, sort by Y position (highest Y means closest to the ground)
    if (matchingMeteors.length > 0) {
        matchingMeteors.sort((a, b) => b.meteor.y - a.meteor.y);
        let target = matchingMeteors[0];
        return { type: 'meteor', index: target.originalIndex, obj: target.meteor };
    }
    
    return null; 
}

function fireLaser(val) {
    if (val === "") return;
    let ans = parseInt(val);
    const target = findTarget(ans);

    if (target) {
        if (target.type === 'shield') breakBossShield(target.obj);
        else destroyMeteor(target.obj, target.index);
        if (window.inputField) window.inputField.value = "";
    } else {
        handleMiss(val);
    }

    // Sa loob ng fireLaser...
    if (target) {
        state.shootTimer = Date.now(); // <--- ADD THIS LINE
    }
}

function breakBossShield(boss) {
    boss.shield.active = false;
    window.Sound.boom();
    createParticles(boss.x, boss.y, "cyan", 50);
    state.floatingTexts.push({ x: boss.x, y: boss.y, text: "SHIELD SHATTERED!", color: "#00f3ff", life: 2.0 });
}

function destroyMeteor(m, idx) {
    if (window.handleCombo) window.handleCombo(true, m.x, m.y);
    
    // Log Success
    registerAction(m.question, m.answer, m.answer, 'correct');

    // 🚨 NEMESIS REDEMPTION: Remove from "Weakness List"
    if (m.isNemesis) {
        let cleanQ = m.question.replace("⚠️ ", "");
        if (state.nemesisList) {
            state.nemesisList = state.nemesisList.filter(item => item.q !== cleanQ);
        }
        state.floatingTexts.push({ x: m.x, y: m.y - 50, text: "WEAKNESS OVERCOME!", color: "#00ff41", life: 2.0 });
        if(window.Sound) window.Sound.speak("Weakness neutralized.");
    }

    // Laser Visuals Setup
    let myTurretX = (state.gameMode === 'party') ? getTurretX(myPlayerIndex, totalPlayers) : (state.gameMode === 'vs' ? window.canvas.width/4 : window.canvas.width/2);
    let fxId = (state.equipped && state.equipped.fx) ? state.equipped.fx : 'fx_blue';
    let fxItem = (typeof shopCatalog !== 'undefined') ? shopCatalog.fx.find(i => i.id === fxId) : null;
    let laserColor = fxItem ? fxItem.color : "#00e5ff";

    state.lasers.push({ 
        x1: myTurretX, y1: window.canvas.height - 220, 
        x2: m.x, y2: m.y, 
        life: 1.0, isAlly: false, color: laserColor 
    });

    if (m.isSupply) { 
        handleSupplyCrate(m); 
        state.meteors.splice(idx, 1); 
    } else if (m.isBoss) { 
        handleBossHit(m, idx); 
    } else { 
        // ⚡ OVERDRIVE PHYSICS INJECTION (CLEANED)
        if (state.isOverdrive) {
            createParticles(m.x, m.y, "#ffd700", 80); 
            window.Sound.laser(); window.Sound.nuke(); 
            window.triggerHitStop(80); 
            state.shake = 40; 
            state.score += 5; 
        } else {
            createParticles(m.x, m.y, laserColor, 40); 
            window.Sound.laser(); window.Sound.boom(); 
            window.triggerHitStop(40); 
            state.shake = 20; 
        }
        
        state.meteors.splice(idx, 1); 
        applyRewards(); 
    }
    
    if (state.gameMode === 'party') socket.emit('player_shoot', { room: currentRoomId, targetId: m.id, pIndex: myPlayerIndex, totalP: totalPlayers, tx: m.x, ty: m.y }); 
    updateHUD();
}

function handleMiss(val, meteorObj = null) {

    // --- 🐾 PET SHIELD POWER (GUARDIAN CLASS) ---
    if (state.petData && state.petData.shieldCharges > 0) {
        state.petData.shieldCharges--;
        
        // Pambihirang Visuals
        state.shake = 5;
        if(window.Sound) window.Sound.powerup(); // Tumunog na parang may shield na sumalo
        
        // Kunin yung pet info para sa pangalan
        let petInfo = window.getCurrentPet();
        state.floatingTexts.push({ 
            x: window.canvas.width / 2, 
            y: window.canvas.height / 2, 
            text: `🛡️ PROTECTED BY ${petInfo.name.toUpperCase()}!`, 
            color: "#00e5ff", 
            life: 2.0 
        });
        
        console.log("Mistake absorbed by pet. Charges left:", state.petData.shieldCharges);
        return; // EXIT EARLY! Walang bawas sa HP, walang bawas sa Combo, walang record sa mistakes log!
    }
    // ... (tuloy na sa original code mo ng handleMiss pababa) ...    
    if (window.triggerGlitch) window.triggerGlitch(); 
    if (window.handleCombo) window.handleCombo(false, null, null);
    
    // Get Question Data
    let qLog = meteorObj ? meteorObj.question : "UNKNOWN";
    let aLog = meteorObj ? meteorObj.answer : "?";
    let statusLog = (val === "MISSED") ? 'missed' : 'wrong';

    // 1. Record to History (General Log)
    registerAction(qLog, aLog, val, statusLog);

    // 🟢 2. FIX: ADD TO MISTAKES ARRAY (Para bumaba ang Accuracy)
    state.mistakes.push({
        q: qLog,
        a: aLog,
        wrong: val,
        type: statusLog
    });

    // 3. Nemesis Protocol
    if (qLog !== "UNKNOWN" && state.nemesisList) {
        const alreadyExists = state.nemesisList.some(item => item.q === qLog);
        if (!alreadyExists) {
            console.log("⚠️ WEAKNESS DETECTED:", qLog);
            state.nemesisList.push({ q: qLog, a: aLog });
            if(window.Sound) window.Sound.speak("Weakness noted.");
        }
    }

    if (state.gameMode === 'classroom') { 
        // Tanggalin ang lock para makabawi agad ang bata
        state.score = Math.max(0, state.score - 10); 
        
        // Mag-flash lang ng red screen mabilis para alam nilang mali
        window.triggerDamageGlitch(); 
        if(window.Sound) window.Sound.error();

        updateHUD(); 
        return; 
    }

    if(window.Sound) window.Sound.error(); 
    state.health -= 10; 
    updateHUD(); 
    if (state.health <= 0) gameOver();
}

function handleBossHit(m, idx) {
    if (m.isEntering) { createParticles(m.x, m.y + 150, "cyan", 5); return; }
    
    // Damage Effect
    m.hp--; 
    createParticles(m.x, m.y, "red", 15); 
    if(window.Sound) window.Sound.boom(); 
    state.shake = 10; 
    if(window.showDamage) window.showDamage(m.x, m.y);

    if (m.hp <= 0) {
        // --- BOSS DEFEATED ---
        if(window.Sound) window.Sound.nuke(); 
        createParticles(m.x, m.y, "gold", 200); 
        state.meteors.splice(idx, 1); 
        state.bossActive = false; 
        
        if (!cityLoaded && window.generateCity) generateCity();
        state.floatingTexts.push({ x: window.canvas.width / 2, y: 200, text: "TARGET NEUTRALIZED!", color: "#00ff41", life: 3.0 });
        state.shake = 50;
        
        // 🟢 NEW CAMPAIGN PROGRESSION LOGIC
        // 🟢 NEW CAMPAIGN PROGRESSION LOGIC
        if (state.gameMode === 'campaign') {
            state.meteors = []; 
            
            setTimeout(async () => {
                // 🚨 SAVE THE CURRENT LEVEL PARA SA REWARD CHECK MAMAYA
                if (state.currentCampaignLevel === currentUser.campaignChapter) {
                    window.pendingRewardLevel = state.currentCampaignLevel; // Trigger for loot
                    currentUser.campaignChapter += 1; 
                    
                    if (currentUser.uid) {
                        await updateDoc(doc(db, "users", currentUser.uid), { 
                            campaignChapter: currentUser.campaignChapter 
                        });
                    }
                } else {
                    window.pendingRewardLevel = null; // Walang reward kung inulit lang ang lumang level
                }
                
                gameVictory("SECTOR CLEARED");
            }, 2000);
        
        } else {
            // Normal Survival Mode (Level up lang ng walang katapusan)
            state.level++; 
            state.xp = 0;
        }
        
    } else {
        // --- BOSS REGENERATES QUESTION (Progressive Difficulty) ---
        
        // Calculate HP Percentage
        let hpPercent = (m.hp / m.maxHp) * 100;

        if (m.hp === 1) {
            // 🔥 CRITICAL STATE: LAST LIFE (FINISHER)
            // Request: "Digit na except multiplication" (Single digits, + or - only)
            if(window.Sound) window.Sound.speak("Critical Damage. System failing.");
            
            let n1 = Math.floor(Math.random() * 9) + 1; // 1-9
            let n2 = Math.floor(Math.random() * 9) + 1; // 1-9
            let isSub = Math.random() > 0.5; // 50/50 Chance + or -
            
            if (isSub) {
                 // Subtraction
                 m.question = `${n1} - ${n2}`;
                 m.answer = n1 - n2;
            } else {
                 // Addition
                 m.question = `${n1} + ${n2}`;
                 m.answer = n1 + n2;
            }
            
            // Visual Cue for Critical State
            state.floatingTexts.push({ x: m.x, y: m.y - 100, text: "FINISH HIM!", color: "red", life: 1.0 });

        } else if (hpPercent < 50) {
            // ⚠️ HARD MODE (Lower than 50% HP)
            // Algebra or Hard Arithmetic
            let newQ = generateMath(true); // Force Hard
            m.question = newQ.q;
            m.answer = newQ.a;
            
        } else {
            // 🛡️ NORMAL MODE (Full Health)
            // Standard Difficulty based on level
            let newQ = generateMath(false); 
            m.question = newQ.q;
            m.answer = newQ.a;
        }
    }
}



function applyRewards() {
    let xpGain = 10; 
    let coinGain = 5;
    
    // 1. Base Difficulty Multipliers
    if (state.difficulty === 'easy') { xpGain = 5; coinGain = 2; } 
    else if (state.difficulty === 'hard') { xpGain = 20; coinGain = 15; }
    
    // 🚨 FIX 3: APPLY SHOP UPGRADES
    // Add Coin Bonus (e.g., +1, +2 coins per kill)
    if (state.coinBonus) {
        coinGain += state.coinBonus;
    }

    // Apply Score Multiplier (e.g., +5% score)
    if (state.scoreMultiplier && state.scoreMultiplier > 1) {
        xpGain = Math.floor(xpGain * state.scoreMultiplier);
    }
    // --- 🐾 PET AFFINITY & ECONOMY POWERS ---
    let myPet = window.getCurrentPet();
    if (myPet) {
        // TINGNAN KUNG MATCH ANG ELEMENT NG PET SA MATH NA NILALARO
        let isAffinityMatch = (myPet.affinity === 'All' || state.selectedOps.includes(myPet.affinity));
        let multiplier = isAffinityMatch ? 2 : 1; // Madodoble ang effect kung tama ang Math!

        // SCAVENGER CLASS (Bonus Coins)
        if (myPet.class === 'Scavenger' || myPet.id === 'pet_l2') {
            let coinBuff = 0;
            if (myPet.id === 'pet_c1') coinBuff = 0.05; // 5%
            if (myPet.id === 'pet_r2') coinBuff = 0.15; // 15%
            if (myPet.id === 'pet_l2') coinBuff = 0.50; // 50%
            
            // Apply bonus
            coinGain += Math.ceil(coinGain * (coinBuff * multiplier));
        }
        
        // SCORE/XP BUFFS
        if (myPet.id === 'pet_r2') xpGain += Math.ceil(xpGain * (0.15 * multiplier));
        if (myPet.id === 'pet_l1') xpGain += Math.ceil(xpGain * (0.30 * multiplier));
        if (myPet.id === 'pet_l2' && isAffinityMatch) xpGain *= 2; // Double XP kung Algebra!
        if (myPet.id === 'pet_m1') xpGain += Math.ceil(xpGain * (1.0 * multiplier)); // Void Leviathan = +100% Score!
        
        // Optional Visual para alam ng player na gumagana yung Pet Affinity
        if (isAffinityMatch && Math.random() > 0.9) {
            state.floatingTexts.push({ x: window.canvas.width/2 + 100, y: window.canvas.height - 150, text: "🐾 AFFINITY BUFF!", color: "#ffd700", life: 1.0 });
        }
    }

    // 2. Update State
    state.score += xpGain; 
    state.coins += coinGain; 
    state.shake = 8;

    // Visual Feedback (Paminsan-minsan ipakita ang bonus)
    if (state.coinBonus > 0 && Math.random() > 0.8) {
        state.floatingTexts.push({ 
            x: window.canvas.width/2 + 50, y: window.canvas.height - 100, 
            text: "BONUS COIN!", color: "gold", life: 0.5 
        });
    }

    // 3. Multiplayer/Classroom Sync Logic
    // 3. Multiplayer/Classroom Sync Logic
    if (state.gameMode === 'party') {
        if (isHost) { 
            state.xp += xpGain; 
            state.score += xpGain; // 🟢 FIX 3A: Host adds the score directly
            checkLevelUp(); 
            updateHUD();
            if (socket) {
                // Ipasa pati ang score para sabay lahat
                socket.emit('host_sync_xp', { room: currentRoomId, xp: state.xp, maxXp: state.xpToNext, sharedScore: state.score });
            }
        } 
        else if (socket) { 
            // 🟢 FIX 3A: Client sends the command to the host to add score
            socket.emit('client_xp_gain', { room: currentRoomId, amount: xpGain }); 
        }
    } else {
        // Solo Logic
        state.score += xpGain; 
        state.xp += xpGain; 
        checkLevelUp();
    }
}

window.checkLevelUp = function() {
    if (state.bossActive) return; 
    if (state.gameMode === 'party' && !isHost) return; 
    state.xpToNext = 50; 
    if (state.xp >= state.xpToNext) {
        state.level++; state.xp = 0; state.spawnRate = Math.max(800, state.spawnRate - 100); 
        triggerLevelUpVisuals();
        if (state.gameMode === 'party' && isHost && socket) { socket.emit('host_sync_level', { room: currentRoomId, level: state.level }); }
    }
};

function triggerLevelUpVisuals() {
    state.floatingTexts.push({ x: window.canvas.width/2, y: 150, text: `LEVEL UP! ${state.level}`, color: "#00e5ff", life: 2.0 });
    if (state.level % 5 === 0) { if(window.Sound) window.Sound.speak("Warning. Boss approaching."); } else { if(window.Sound) window.Sound.powerup(); }
    updateHUD(); 
}

// ==========================================
// 💰 ECONOMY & POWER-UP BALANCE V2
// ==========================================

window.activateEMP = function() { 
    if (Date.now() - state.lastSkillTime < 1000) return; 
    if (state.coins >= 250) { // 📈 TUMAAS ANG PRESYO: 250
        state.lastSkillTime = Date.now(); 
        triggerEMP(false, false, false); 
    } else { 
        window.Sound.error(); window.Sound.speak("Insufficient Funds"); 
    } 
};

window.activateSlowMo = function() { 
    if (Date.now() - state.lastSkillTime < 1000) return; 
    if (state.coins >= 100) { // 📈 TUMAAS ANG PRESYO: 100
        state.lastSkillTime = Date.now(); 
        triggerSlowMo(false, false); 
    } else { 
        window.Sound.error(); window.Sound.speak("Insufficient Funds"); 
    } 
};

// ☢️ ADVANCED EMP ENGINE (With Mini-Nuke Mode & No-EXP Rule)
window.triggerEMP = function(isFree, fromSocket = false, isMini = false, originX = window.canvas.width/2, originY = window.canvas.height) {
    if (!isFree) { 
        if (state.coins < 250) { window.Sound.error(); window.Sound.speak("Insufficient Funds"); return; } 
        state.coins -= 250; 
    }
    
    window.Sound.nuke();
    let blastRadius = isMini ? 400 : 9999; // Mini Nuke (400px) vs Full EMP (Infinite)
    let blastColor = isMini ? "orange" : "#00e5ff";

    if(!fromSocket) { 
        window.Sound.speak(isMini ? "Mini Nuke Detonated" : "EMP Activated"); 
        state.shockwaves.push({x: originX, y: originY, radius: 10, maxRadius: isMini ? 450 : 1500, alpha: 1.0, color: blastColor}); 
        state.shake = isMini ? 15 : 30; 
    }
    
    // Wasakin ang mga sakop ng Radius
    for(let i = state.meteors.length - 1; i >= 0; i--) {
        let m = state.meteors[i];
        let distance = Math.hypot(m.x - originX, m.y - originY); // Calculate range
        
        if (distance <= blastRadius) {
            if(m.isBoss) { 
                m.hp -= isMini ? 2 : 5; 
            } else if (!m.isSupply) { 
                createParticles(m.x, m.y, blastColor, 20); 
                state.meteors.splice(i, 1); 
                // 🛑 NO SCORE ADDED! WALANG: state.score += 10;
            }
        }
    }
    
    updateHUD(); 
    if(!fromSocket && state.gameMode === 'party' && socket) {
        socket.emit('use_skill', { room: currentRoomId, type: 'EMP', isMini: isMini, x: originX, y: originY });
    }
};

window.triggerSlowMo = function(isFree, fromSocket = false) {
    if (!isFree) { 
        if (state.coins < 100) { window.Sound.error(); window.Sound.speak("Insufficient Funds"); return; } 
        state.coins -= 100; 
    }
    window.Sound.powerup();
    if(!fromSocket) { 
        window.Sound.speak("Time Slowed!"); 
        state.floatingTexts.push({x: window.canvas.width/2, y: window.canvas.height/2 - 50, text: "SLOW MOTION", color: "#00e5ff", life: 2.0}); 
    }
    state.isSlowed = true; 
    setTimeout(() => { 
        state.isSlowed = false; 
        if(!fromSocket) window.Sound.speak("Time Normal."); 
    }, 5000);
    updateHUD(); 
    if(!fromSocket && state.gameMode === 'party' && socket) socket.emit('use_skill', { room: currentRoomId, type: 'SLOW' });
};

// 📦 SUPPLY CRATE UPDATE
window.handleSupplyCrate = function(m) {
    window.Sound.powerup(); let roll = Math.random();
    if (roll < 0.25) { 
        state.health = Math.min(100, state.health + 10); 
        state.floatingTexts.push({x:m.x, y:m.y, text:"HP +10", color:"#00e5ff", life:1.5}); 
    } 
    else if (roll < 0.50) { 
        state.coins += 30; 
        state.floatingTexts.push({x:m.x, y:m.y, text:"COINS +30", color:"#fca311", life:1.5}); 
    } 
    else if (roll < 0.75) { 
        window.triggerSlowMo(true); 
        state.floatingTexts.push({x:m.x, y:m.y, text:"FREEZE CACHE!", color:"white", life:1.5}); 
    } 
    else { 
        // 💥 MINI NUKE TRIGGERED (It will blast from the crate's exact location!)
        window.triggerEMP(true, false, true, m.x, m.y); 
        state.floatingTexts.push({x:m.x, y:m.y, text:"MINI NUKE", color:"orange", life:1.5}); 
    }
    createParticles(m.x, m.y, "gold", 30);
};

// 📡 MULTIPLAYER SYNC FIX (Para gumana ang Mini Nuke sa kakampi)
if (socket) {
    socket.on('sync_skill', (data) => {
        if (state.gameMode === 'party' && state.isPlaying) {
            if (data.type === 'EMP') window.triggerEMP(true, true, data.isMini, data.x, data.y); 
            if (data.type === 'SLOW') window.triggerSlowMo(true, true);
        }
    });
}





window.playOutroSequence = function(isWin) {
    const outro = document.getElementById('cinematic-outro');
    const title = document.getElementById('outro-title');
    const sub = document.getElementById('outro-sub');
    
    // 1. Setup Visuals
    outro.classList.remove('hidden');
    
    if (isWin) {
        title.innerText = "MISSION ACCOMPLISHED";
        title.style.color = "#ffd700"; // Gold
        sub.innerText = "SECURING VICTORY DATA...";
        if(window.Sound) window.Sound.speak("Mission Accomplished. Returning to base.");
    } else {
        title.innerText = "SIGNAL LOST";
        title.style.color = "#ff0055"; // Red
        sub.innerText = "RECOVERING BLACK BOX...";
        if(window.Sound) window.Sound.speak("Critical failure. Systems shutting down.");
    }

    // Play Sound Effect
    if(window.Sound) window.Sound.playTone(100, 'sawtooth', 1.0); // Power down sound

    // 2. Wait 3 Seconds, then Show Report
    setTimeout(() => {
        outro.classList.add('hidden'); // Hide Outro
        
        // Show the actual Report Modal
        const reportModal = document.getElementById("report-modal");
        reportModal.classList.remove("hidden");
        
        // Generate Analytics
        if(window.generateMissionDebrief) window.generateMissionDebrief();
        if(window.generateTacticalReport) window.generateTacticalReport();
        
    }, 3000); // 3 Seconds Delay
};

window.gameOver = function() {
    if (state.matchConcluded) return; 
    state.matchConcluded = true;

    document.body.classList.remove('in-combat');
    
    if (typeof scoreInterval !== 'undefined' && scoreInterval) clearInterval(scoreInterval);
    if (state.gameTimer) clearInterval(state.gameTimer);
    if (window.Sound) window.Sound.stopBGM();

    state.isPlaying = false; 
    if(window.inputField) window.inputField.blur();

    // =====================================
    // ⚔️ VS MODE & PARTY MODE DEFEAT HANDLING
    // =====================================
    if (state.gameMode === 'vs' || state.gameMode === 'party') {
        if (socket && currentRoomId) {
            state.health = 0; 
            if (state.gameMode === 'vs') {
                socket.emit('player_died', { room: currentRoomId });
                socket.emit('send_vs_state', { 
                    room: currentRoomId, 
                    state: { meteors: [], lasers: [], health: 0, score: state.score } 
                });
            }
        }
        
        const winModal = document.getElementById("win-modal");
        if(winModal) {
            winModal.classList.remove("hidden");
            const title = winModal.querySelector("h1");
            const sub = winModal.querySelector(".subtitle");
            const content = winModal.querySelector(".modal-content");
            
            if(title) { title.innerText = "DEFEAT"; title.style.color = "#ff0055"; title.style.textShadow = "0 0 20px #ff0055"; }
            if(sub) sub.innerText = state.gameMode === 'party' ? "SQUAD WIPED OUT" : "SYSTEM CRITICAL";
            if(content) { content.style.borderColor = "#ff0055"; content.style.boxShadow = "0 0 30px #ff0055"; }
            
            // 🟢 MULTIPLAYER FIX: Return to Lobby instead of Solo
            const playAgainBtn = winModal.querySelector(".secondary");
            if(playAgainBtn) {
                playAgainBtn.style.display = "block";
                playAgainBtn.innerText = "RETURN TO LOBBY";
                playAgainBtn.onclick = () => window.returnToLobby();
            }
        }
        return; 
    }
}

// ==========================================
// 🛡️ THE MASTER EXIT ROUTER (100% RELOAD BULLETPROOF)
// ==========================================
window.goHome = async function(skipConfirm = false) {
    if(window.Sound && !skipConfirm) window.Sound.click();
    
    // 1. Kumpirmasyon kung nasa kalagitnaan ng laban
    if (!skipConfirm && typeof state !== 'undefined' && state.isPlaying && !confirm("ABORT MISSION? Progress will be lost.")) {
        return;
    }

    console.log("🚀 Initiating Hard Reset Sequence...");
    
    // 2. Ipakita ang Warp Door bilang transition effect
    const warpDoor = document.getElementById("cyber-warp-door");
    if (warpDoor) {
        warpDoor.classList.remove('hidden');
        warpDoor.style.setProperty('z-index', '2147483647', 'important'); // Pinakaharap
        setTimeout(() => warpDoor.classList.add('active'), 10);
        if(window.Sound) window.Sound.playTone(150, 'sawtooth', 0.6); 
    }

    // 3. CLEANUP DATABASE BAGO MAG-RELOAD
    if (typeof currentRoomId !== 'undefined' && currentRoomId) {
        try {
            if (typeof isHost !== 'undefined' && isHost && state.gameMode !== 'classroom') {
                await updateDoc(doc(db, "rooms", currentRoomId), { gameState: 'closed', status: 'archived' });
            } else if (!isHost && state.gameMode !== 'classroom') {
                const roomRef = doc(db, "rooms", currentRoomId);
                const roomSnap = await getDoc(roomRef);
                if(roomSnap.exists()) {
                    let players = roomSnap.data().players || [];
                    players = players.filter(p => p.name !== myName);
                    await updateDoc(roomRef, { players: players });
                }
            }
        } catch(e) {}
    }

    // 4. CLEAR SESSION (Para hindi pumasok ulit sa Teacher Mode)
    if (sessionStorage.getItem('jess_session')) {
        sessionStorage.removeItem('jess_session');
    }

    // 5. THE RELOAD EXECUTION (Babalik sa Main Menu nang 100% Clean)
    setTimeout(() => {
        window.location.reload(); 
    }, 1000); // 1-second delay para bumagsak ang pinto
};

// ==========================================
// 👨‍🏫 TEACHER EXITS (ROUTES DIRECTLY TO GOHOME RELOAD)
// ==========================================
window.closeClassEntirely = function() {
    if(window.Sound) window.Sound.click();
    
    const exitBtn = document.getElementById('btn-exit-dash');
    if(exitBtn) { 
        exitBtn.disabled = true; 
        exitBtn.innerText = "EXITING..."; 
    }
    
    // I-update ang Firebase bago mag-reload
    if (typeof currentRoomId !== 'undefined' && currentRoomId) {
        updateDoc(doc(db, "rooms", currentRoomId), { status: 'archived' }).then(() => {
            window.goHome(true); 
        }).catch(() => { 
            window.goHome(true); 
        }); 
    } else {
        window.goHome(true);
    }
};

// Siguraduhing tumatawag din sa Reload ang Pause Menu Quit Button
window.quitFromPause = function() {
    if(window.Sound) window.Sound.click();
    if(confirm("ABORT MISSION? Progress will be lost.")) {
        document.getElementById("pause-modal")?.classList.add("hidden");
        window.goHome(true); // Tatawagin ang Reload
    }
};




// Aliasing the global function just in case older code calls it directly
function gameOver() { window.gameOver(); }      

// Inside function gameOver()
if(state.gameMode === 'classroom') {
    // Hide the "Quit" button so they stay for the next round
    const homeBtn = document.querySelector('#report-modal .text-only');
    if(homeBtn) homeBtn.style.display = 'none';
    
    const retryBtn = document.querySelector('#report-modal .secondary'); // The Retry Mission button
    if(retryBtn) retryBtn.style.display = 'none'; // They can't retry manually, only Teacher starts it
}

function gameVictory(reason) {
    if (state.matchConcluded) return; // Prevent double firing
    state.matchConcluded = true;

    state.isPlaying = false; 
    if(window.inputField) window.inputField.blur();
    
    if(window.Sound) window.Sound.powerup(); 
    
    const winModal = document.getElementById("win-modal");
    const winTitle = winModal.querySelector("h1");
    const winSub = winModal.querySelector(".subtitle");
    const winContent = winModal.querySelector(".modal-content");

    winModal.classList.remove("hidden"); 
    document.getElementById("win-score").innerText = state.score;

    // Styling for VICTORY
    winTitle.innerText = "VICTORY!";
    winTitle.style.color = "#00ff41"; // Green
    winTitle.style.textShadow = "0 0 20px #00ff41";
    
    winSub.innerText = reason || "OPPONENT ELIMINATED";
    winSub.style.color = "#fff";

    winContent.style.borderColor = "#00ff41";
    winContent.style.boxShadow = "0 0 30px #00ff41";

    // (Inside gameVictory function, palitan ang button logic block ng ganito:)
    
    // 🟢 MULTIPLAYER BUTTON FIX
    // 🟢 MULTIPLAYER BUTTON FIX (Dideretso na sa Main Dashboard!)
    const playAgainBtn = winModal.querySelector(".secondary");
    
    if (state.gameMode === 'vs' || state.gameMode === 'party') {
        if(playAgainBtn) {
            playAgainBtn.style.display = "block";
            playAgainBtn.innerText = "RETURN TO BASE"; // Pinalitan natin ang text
            playAgainBtn.onclick = () => {
                if(window.Sound) window.Sound.click();
                winModal.classList.add("hidden");
                
                // Sabihin sa server na umalis na siya sa room bago mag-exit
                if (currentRoomId && !isHost) {
                    const roomRef = doc(db, "rooms", currentRoomId);
                    getDoc(roomRef).then(snap => {
                        if(snap.exists()) {
                            let players = snap.data().players || [];
                            players = players.filter(p => p.name !== myName);
                            updateDoc(roomRef, { players: players });
                        }
                    });
                }
                window.goHome(true); // 🟢 Master Exit Triggered!
            };
        }
    }

    
}






function createParticles(x, y, color, count) { 
    for(let i=0; i<count; i++) {
        let colors = ["#00e5ff", "#00b8cc", "#ffffff"];
        if(color === 'gold') colors = ["#fca311", "#ffc800", "#ffeb3b"]; 
        if(color === 'red') colors = ["#ff0055", "#ff0000", "#ff5555"]; 
        let pColor = (color === "cyan") ? "#00e5ff" : colors[Math.floor(Math.random() * colors.length)];
        state.particles.push({x:x, y:y, vx:(Math.random()-0.5)*15, vy:(Math.random()-0.5)*15, life:1.0, color:pColor, size:4, drag:0.95}); 
    }
}

function drawLightning(ctx, x, y, width, height) {
    ctx.save(); ctx.strokeStyle = "rgba(200, 255, 255, 0.9)"; ctx.lineWidth = 4; ctx.shadowBlur = 30; ctx.shadowColor = "#00e5ff"; ctx.lineCap = "round";
    let numBolts = Math.floor(Math.random() * 3) + 2; 
    for (let i = 0; i < numBolts; i++) {
        let startX = x + (Math.random() - 0.5) * width * 1.2; let startY = y + (Math.random() - 0.5) * height * 1.2;
        ctx.beginPath(); ctx.moveTo(startX, startY);
        let segments = Math.floor(Math.random() * 3) + 4; let currX = startX; let currY = startY;
        for (let j = 0; j < segments; j++) {
            let nextX = currX + (Math.random() - 0.5) * 100; let nextY = currY + (Math.random() - 0.2) * 100; 
            ctx.lineTo(nextX, nextY); currX = nextX; currY = nextY;
        }
        ctx.stroke();
    }
    ctx.restore();
}

function drawGame(ctx, objects, offsetX, isOpponent) {
    let time = Date.now();
    
    objects.forEach(m => {
        let drawX = m.x + offsetX;
        let qText = isOpponent ? m.q : m.question;
        
        ctx.save(); ctx.translate(drawX, m.y);

        // =========================================
        // 1. DRAW SUPPLY CRATE (Briefcase)
        // =========================================
        if (m.isSupply) {
            let size = m.radius * 2.8; 
            
            ctx.translate(0, Math.sin(time / 400) * 8); 
            ctx.rotate(Math.sin(time / 1000) * 0.15); 

            // Parachute Lines
            ctx.beginPath();
            ctx.moveTo(0, -size/1.5); ctx.lineTo(-size/4, 0); 
            ctx.moveTo(0, -size/1.5); ctx.lineTo(size/4, 0);    
            ctx.strokeStyle = "rgba(255, 215, 0, 0.5)"; ctx.lineWidth = 2; ctx.stroke();

            // Draw Image
            if (supplyLoaded) {
                ctx.drawImage(assets.misc.supply.img, -size/2, -size/2, size, size);
            } else {
                ctx.fillStyle = "rgba(255, 215, 0, 0.2)";
                ctx.strokeStyle = "#ffd700"; ctx.lineWidth = 3;
                ctx.strokeRect(-30, -20, 60, 40); ctx.fillRect(-30, -20, 60, 40);
            }

            // Equation Box
            ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
            ctx.beginPath(); ctx.roundRect(-50, 25, 100, 35, 5); ctx.fill();
            ctx.strokeStyle = "#ffd700"; ctx.lineWidth = 2; ctx.stroke();

            // Text
            ctx.font = "900 22px 'Rajdhani'"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillStyle = "#ffd700"; ctx.shadowBlur = 5; ctx.shadowColor = "gold";
            ctx.fillText(qText, 0, 44); 
            ctx.font = "bold 12px 'Orbitron'"; ctx.fillStyle = "#fff"; ctx.shadowBlur = 0;
            ctx.fillText("SUPPLY", 0, -size/2 - 10);
        } 
        
        // Inside drawGame function, find the "else if (m.isBoss)" block:

        // PALITAN ANG BUONG `else if (m.isBoss) { ... }` BLOCK SA LOOB NG drawGame NG GANITO:

        else if (m.isBoss) {
             let bossW = 600; let bossH = 450;
             let skinID = m.skin || 'boss_def';
             let imgObj = (assets.boss && assets.boss[skinID]) ? assets.boss[skinID].img : null;
             if (!imgObj) imgObj = assets.boss['boss_def'].img;

             // 🟢 NEW: DRAW AURA FIRST PARA NASA LIKOD NG BOSS!
             if(window.handleBossMechanics) window.handleBossMechanics(ctx, m, time);

             if(imgObj && imgObj.complete) {
                 // Pabibilisin natin ang pagbaba niya mamaya sa gameLoop
                 ctx.translate(0, Math.sin(time/800)*15); 
                 ctx.drawImage(imgObj, -bossW/2, -bossH/2, bossW, bossH);
                 
                 // Boss Mechanics (Shield) - sa harap
                 if (!isOpponent && !m.isEntering) {
                    if(window.drawBossShield) window.drawBossShield(ctx, m, time);
                 }
             } else { 
                 // Fallback Red Circle
                 ctx.fillStyle = "#550000"; ctx.beginPath(); ctx.arc(0,0,200,0,Math.PI*2); ctx.fill(); 
                 ctx.strokeStyle = "red"; ctx.lineWidth = 10; ctx.stroke();
             }
        }
        
        else {
            let mainColor = isOpponent ? "#ff0055" : "#00e5ff";
            
            // 🚀 GAGAMITIN NATIN ANG NORMAL SHIPS PARA SA LAHAT NG MODES (KASAMA ANG CLASSROOM)
            let shipSize = m.radius * 2.2; 
            let flicker = Math.random() * 0.5 + 0.8;
            
            ctx.save();
            ctx.translate(0, -shipSize/2.5); 
            ctx.fillStyle = mainColor;
            ctx.shadowBlur = 15; ctx.shadowColor = mainColor;
            ctx.globalAlpha = 0.6;
            ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(8, 0); ctx.lineTo(0, -30 * flicker); ctx.fill();
            ctx.restore();

            let skinID = m.skin || 'enemy_def';
            let imgObj = (assets.enemies[skinID]) ? assets.enemies[skinID].img : assets.enemies['enemy_def'].img;

            if (imgObj && imgObj.complete && !m.isGolden) {
                ctx.rotate(Math.PI); 
                ctx.drawImage(imgObj, -shipSize/2, -shipSize/2, shipSize, shipSize);
                ctx.rotate(-Math.PI); 
            } else {
                ctx.fillStyle = "#0a0a10";
                ctx.beginPath(); ctx.arc(0,0, m.radius, 0, Math.PI*2); ctx.fill();
                ctx.strokeStyle = mainColor; ctx.lineWidth = 2; ctx.stroke();
            }

            // HUD Plate (Equation Background)
            ctx.fillStyle = "rgba(0, 5, 10, 0.9)"; 
            ctx.strokeStyle = m.isGolden ? "gold" : mainColor;
            ctx.lineWidth = 2;
            ctx.beginPath(); 
            ctx.roundRect(-40, -15, 80, 30, 5); 
            ctx.fill(); ctx.stroke();

            // Equation Text
            ctx.font = "900 20px 'Rajdhani'";
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillStyle = "#ffffff";
            ctx.shadowBlur = 5; ctx.shadowColor = mainColor;
            ctx.fillText(qText, 0, 2); 
        }
        
        ctx.restore();

        // Boss HUD Text (Outside rotation)
        if (m.isBoss) {
            ctx.save();
            ctx.translate(drawX, m.y + 80); 
            
            ctx.fillStyle = "rgba(0, 0, 0, 0.9)"; 
            ctx.fillRect(-140, -40, 280, 80);
            ctx.strokeStyle = "#ff0055"; ctx.lineWidth = 4; ctx.strokeRect(-140, -40, 280, 80);
            
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.font = "900 48px 'Orbitron'"; ctx.fillStyle = "#ffffff";
            ctx.shadowBlur = 20; ctx.shadowColor = "#ff0055";
            ctx.fillText(qText, 0, 5); 
            
            ctx.font = "bold 14px 'Rajdhani'"; ctx.fillStyle = "gold"; ctx.shadowBlur = 0;
            ctx.fillText("⚠️ CORE TARGET ⚠️", 0, -55);
            ctx.restore();
        }
    });
}

// ==========================================
// 💥 OVERDRIVE: COMBAT FEEDBACK TRIGGERS
// ==========================================
window.hitStopEnd = 0;

window.triggerHitStop = function(durationMs = 40) {
    window.hitStopEnd = performance.now() + durationMs;
    document.body.classList.add('hit-stop-active');
    setTimeout(() => { document.body.classList.remove('hit-stop-active'); }, durationMs + 50);
};

window.triggerDamageGlitch = function() {
    let wrapper = document.getElementById("game-wrapper");
    if (wrapper) {
        wrapper.classList.remove("damage-glitch");
        void wrapper.offsetWidth; // Force CSS reflow
        wrapper.classList.add("damage-glitch");
        setTimeout(() => wrapper.classList.remove("damage-glitch"), 300);
    }
    state.shake = 35; // Violent shake
    if(window.Sound) window.Sound.error();
};


function gameLoop(time) {
    if(!state.isPlaying || state.isPaused) return;

    if (time < window.hitStopEnd) {
        requestAnimationFrame(gameLoop);
        return; 
    }

    let dt = time - state.lastTime; 
    state.lastTime = time; 
    if (dt > 100) dt = 16.67; 
    
    let delta = dt / 16.67; 
    if(delta > 4) delta = 4;

    if(window.drawDeepSpace) window.drawDeepSpace();

    if(cityLoaded) { 
        window.ctx.drawImage(assets.misc.city.img, 0, 0, window.canvas.width, window.canvas.height); 
        window.ctx.fillStyle = "rgba(0, 5, 15, 0.5)"; 
        window.ctx.fillRect(0,0,window.canvas.width, window.canvas.height); 

        let grad = window.ctx.createLinearGradient(0, window.canvas.height - 150, 0, window.canvas.height);
        grad.addColorStop(0, "rgba(0, 0, 0, 0)");
        grad.addColorStop(1, "rgba(0, 243, 255, 0.15)");
        window.ctx.fillStyle = grad;
        window.ctx.fillRect(0, window.canvas.height - 150, window.canvas.width, 150);
    } else { 
        window.ctx.clearRect(0, 0, window.canvas.width, window.canvas.height);
        if (state.stars) {
            window.ctx.fillStyle = "#ffffff";
            state.stars.forEach(s => {
                s.y += (s.speed * 2) * delta;
                if (s.y > window.canvas.height) { s.y = 0; s.x = Math.random() * window.canvas.width; }
                window.ctx.globalAlpha = Math.random() * 0.5 + 0.5;
                window.ctx.beginPath(); window.ctx.arc(s.x, s.y, s.size, 0, Math.PI*2); window.ctx.fill();
            });
            window.ctx.globalAlpha = 1.0;
        }
    }

    window.ctx.save();
    if(state.shake > 0) { 
        window.ctx.translate((Math.random() - 0.5) * state.shake, (Math.random() - 0.5) * state.shake); 
        state.shake *= 0.9; 
        if(state.shake < 0.5) state.shake = 0; 
    }

    let groundColor = state.level > 10 ? "#ff0055" : (state.level > 5 ? "#00ff41" : "#00e5ff");
    let groundY = window.canvas.height - 40;
    window.ctx.fillStyle = "#020205"; window.ctx.fillRect(0, groundY, window.canvas.width, 40);
    window.ctx.strokeStyle = groundColor; window.ctx.lineWidth = 2; 
    window.ctx.shadowBlur = 10; window.ctx.shadowColor = groundColor;
    window.ctx.beginPath(); window.ctx.moveTo(0, groundY); window.ctx.lineTo(window.canvas.width, groundY); window.ctx.stroke();
    window.ctx.shadowBlur = 0; 

    // 🟢 FIX: Allowed na mag-spawn gamit ang normal timer ang Classroom!
    if(state.gameMode === 'solo' || isHost || state.gameMode === 'vs' || state.gameMode === 'campaign' || state.gameMode === 'classroom') {
        let kills = Math.floor(state.score / 10);
        if (state.gameMode === 'campaign' && kills >= 10 && !state.bossActive) {
            spawnMeteor(0, 0, false); 
        } 
        else if (time - state.spawnTimer > state.spawnRate) { 
            if (!state.bossActive) {
                spawnMeteor(0,0,false); 
                state.spawnTimer = time; 
            }
        }
    }

    let speedFactor = state.isSlowed ? 0.2 : 1.0; 
    let hudNeedsUpdate = false; 

    // --- PHYSICS LOOP ---
    for (let i = state.meteors.length - 1; i >= 0; i--) {
        let m = state.meteors[i];

        // 🟢 FIX: Standard Gravity for ALL modes (No more bouncing)
        if (m.isBoss) {
           if(m.isEntering) { 
               m.y += (m.speed * 3.0) * delta; 
               state.shake = 3; 
               if(m.y >= 150) { m.isEntering = false; window.Sound.boom(); m.lastSpawn = time; } 
           } else { 
               m.x = (window.canvas.width / 2) + Math.sin(time / 2000) * 200; 
               if (time - m.lastSpawn > 3000) { spawnMeteor(m.x, m.y + 100, true); m.lastSpawn = time; } 
           }
        } else {
           m.y += (m.speed * speedFactor) * delta;
           if (!state.isPaused && Math.random() > 0.95) { 
               let pColor = m.isSupply ? "gold" : (state.gameMode === 'vs' ? "red" : "cyan"); 
               createParticles(m.x + (Math.random()-0.5)*30, m.y - 30, pColor, 1); 
           }
        }
        
        // 🟢 FIX: Standard Ground Collision (Applicable to ALL modes)
        if(m.y > window.canvas.height + 50) {
            if (m.isBoss) { 
                state.shake = 50; window.triggerDamageGlitch(); 
                state.health = 0; // Insta-kill pag lumusot ang boss!
            } 
            else if (m.isSupply) { /* Ignore supply drops */ } 
            else { 
                state.shake = 20; 
                window.triggerDamageGlitch(); 
                
                // 🟢 BAWAS BUHAY SA LAHAT NG MODE
                state.health -= 20; 
                
                // Dagdag parusa sa Class mode (Input Lock at Bawas Score)
                handleMiss("MISSED", m); 
            } 
            
            createParticles(m.x, window.canvas.height-40, "#ff0055", 10); 
            state.meteors.splice(i, 1); 
            hudNeedsUpdate = true;
            
            // 🟢 GAME OVER KUNG UBOS NA BUHAY, KAHIT NASA CLASS MODE
            if(state.health <= 0) {
                gameOver();
            }
        }
    }

    if(hudNeedsUpdate) updateHUD();

    // DRAWING LOGIC
    if(state.gameMode === 'vs') {
        drawGame(window.ctx, state.meteors, 0, false); 
        drawTurretAt(window.canvas.width/4, window.canvas.height, "#00e5ff"); 
        
        // Firewall Divider
        if(window.drawFirewallBarrier) window.drawFirewallBarrier(window.ctx, window.canvas.width, window.canvas.height, time); 
        else { let mid = window.canvas.width / 2; window.ctx.beginPath(); window.ctx.moveTo(mid, 0); window.ctx.lineTo(mid, window.canvas.height); window.ctx.strokeStyle = "#00e5ff"; window.ctx.stroke(); }
        window.ctx.save(); window.ctx.fillStyle = "rgba(50, 0, 0, 0.2)"; window.ctx.fillRect(window.canvas.width/2, 0, window.canvas.width/2, window.canvas.height); window.ctx.restore();
        
        // Opponent Base Elements
        if(state.opponentState.meteors) drawGame(window.ctx, state.opponentState.meteors, window.canvas.width / 2, true); 
        drawTurretAt(window.canvas.width * 0.75, window.canvas.height, "#ff0055"); 
        
        // 🟢 BUG FIX 2: I-draw ang LASERS ng kalaban sa right side!
        if(state.opponentState.lasers) {
            state.opponentState.lasers.forEach(l => {
                window.ctx.lineWidth = 6; window.ctx.strokeStyle = l.color || "#ff0055"; 
                window.ctx.beginPath(); window.ctx.moveTo(l.x1 + window.canvas.width/2, l.y1); window.ctx.lineTo(l.x2 + window.canvas.width/2, l.y2); window.ctx.stroke();
            });
        }
    } else if(state.gameMode === 'party') {
        drawGame(window.ctx, state.meteors, 0, false); 
        for(let i=0; i<totalPlayers; i++) drawTurretAt(getTurretX(i, totalPlayers), window.canvas.height, i===myPlayerIndex?"#00e5ff":"cyan"); 
    } else {
        drawGame(window.ctx, state.meteors, 0, false); 
        drawTurretAt(window.canvas.width/2, window.canvas.height, "#00e5ff");
    }

    // LASERS
    state.lasers = state.lasers.filter(l => {
        l.life -= 0.07 * delta; if (l.life <= 0) return false;
        let mainColor = l.color || "#00e5ff";
        window.ctx.lineWidth = 6; window.ctx.strokeStyle = mainColor; window.ctx.globalAlpha = 0.5 * l.life;
        window.ctx.beginPath(); window.ctx.moveTo(l.x1, l.y1); window.ctx.lineTo(l.x2, l.y2); window.ctx.stroke(); 
        window.ctx.lineWidth = 2; window.ctx.strokeStyle = "#ffffff"; window.ctx.globalAlpha = 1.0 * l.life;
        window.ctx.beginPath(); window.ctx.moveTo(l.x1, l.y1); window.ctx.lineTo(l.x2, l.y2); window.ctx.stroke(); 
        window.ctx.fillStyle = "#ffffff"; window.ctx.beginPath(); window.ctx.arc(l.x2, l.y2, 5, 0, Math.PI*2); window.ctx.fill(); 
        window.ctx.globalAlpha = 1.0;
        return true;
    });

    // PARTICLES
    window.ctx.globalCompositeOperation = "screen";
    for(let i=state.particles.length-1; i>=0; i--) { 
        let p=state.particles[i]; p.x += p.vx * delta; p.y += p.vy * delta; p.life -= 0.05 * delta; 
        window.ctx.beginPath(); window.ctx.strokeStyle = p.color; window.ctx.lineWidth = p.size; window.ctx.globalAlpha = Math.max(0, p.life); 
        let stretchFactor = 2.5; window.ctx.moveTo(p.x, p.y); window.ctx.lineTo(p.x - (p.vx * stretchFactor), p.y - (p.vy * stretchFactor)); window.ctx.stroke(); 
        if(p.life<=0) state.particles.splice(i,1); 
    }
    window.ctx.globalCompositeOperation = "source-over";

    // TEXTS
    for(let i=state.floatingTexts.length-1; i>=0; i--) { 
        let ft=state.floatingTexts[i]; ft.y -= 1.5 * delta; ft.life -= 0.02 * delta; 
        window.ctx.fillStyle=ft.color; window.ctx.font="bold 24px 'Rajdhani'"; window.ctx.globalAlpha=Math.max(0, ft.life); 
        window.ctx.shadowColor = "black"; window.ctx.shadowBlur = 4; window.ctx.fillText(ft.text, ft.x, ft.y); 
        if(ft.life<=0) state.floatingTexts.splice(i,1); 
    }
    
    // SHOCKWAVES
    for(let i=state.shockwaves.length-1; i>=0; i--){ 
        let sw = state.shockwaves[i]; sw.radius += 20 * delta; sw.alpha -= 0.05 * delta; 
        if(sw.alpha > 0) { window.ctx.beginPath(); window.ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI*2); window.ctx.strokeStyle = `rgba(0, 229, 255, ${sw.alpha})`; window.ctx.lineWidth = 5; window.ctx.stroke(); } 
        else state.shockwaves.splice(i, 1); 
    
    }

    // --- ILAGAY ITO SA PINAKADULO NG GAMELOOP ---

    // 🟢 ON-DEMAND CCTV STREAMING (Student Side Only)
    if (state.gameMode === 'classroom' && !isHost && socket && state.isPlaying && window.isBeingWatched) {
        if (!state.lastFrameTime) state.lastFrameTime = 0;
        
        // Magpapadala ng ~6 frames per second (150ms delay)
        if (time - state.lastFrameTime > 150) { 
            state.lastFrameTime = time;
            try {
                if (window.canvas && window.canvas.width > 0) {
                    const frameData = window.canvas.toDataURL('image/jpeg', 0.4); 
                    // Tiyaking tama ang ID na ipapasa
                    let myId = window.myDocId || (currentUser ? currentUser.uid : myName);
                    socket.emit('spy_cam_frame', { room: currentRoomId, uid: myId, frame: frameData });
                }
            } catch(e) {
                console.log("CCTV Error:", e);
            }
        }
    }



    window.ctx.globalAlpha=1.0; 
    window.ctx.restore();

    window.gameLoopId = requestAnimationFrame(gameLoop);
    

}

window.pressKey = function(key) { if(!state.isPlaying || state.isPaused) return; const input = document.getElementById("player-input"); if(input) { input.value += key; if(window.Sound) window.Sound.click(); } };
window.pressClear = function() { const input = document.getElementById("player-input"); if(input) { input.value = ""; if(window.Sound) window.Sound.error(); } };
window.pressEnter = function() { const input = document.getElementById("player-input"); if(input && state.isPlaying) { fireLaser(input.value); input.value = ""; } };
window.addEventListener('load', () => { if(window.innerWidth <= 768) console.log("Mobile Mode Detected"); });

window.handleCombo = function(isHit, x, y) {
    const elContainer = document.getElementById("combo-container"); 
    const elValue = document.getElementById("combo-value");
    
    if (isHit) {
        state.combo++; 
        if (state.combo > state.maxCombo) state.maxCombo = state.combo;
        
        if (state.combo > 1) {
            elContainer.classList.remove("hidden"); 
            elValue.innerText = "x" + state.combo; 
            elValue.classList.remove("combo-pulse"); 
            void elValue.offsetWidth; 
            elValue.classList.add("combo-pulse");
            
            let hypeMsg = ""; let hypeColor = "#fff";
            
            if(state.combo === 5) { 
                hypeMsg = "GREAT!"; hypeColor = "#00ff41"; 
            } 
            else if(state.combo === 10) { 
                // ⚡ OVERDRIVE TRIGGER! ⚡
                hypeMsg = "OVERDRIVE ENGAGED!"; hypeColor = "#ffd700"; 
                window.Sound.speak("Overdrive Protocol engaged."); 
                document.body.classList.add("overdrive-active"); // Turn on CSS Gold Aura
                state.isOverdrive = true;
                window.Sound.nuke(); // Big boom sound!
            } 
            else if(state.combo === 20) { 
                hypeMsg = "UNSTOPPABLE!"; hypeColor = "#ffd700"; window.Sound.speak("Unstoppable!"); 
            } 
            else if(state.combo === 30) { 
                hypeMsg = "MATH GOD!"; hypeColor = "#ff0055"; window.Sound.speak("Math God!"); 
            }
            
            if(hypeMsg !== "") { 
                state.floatingTexts.push({ x: x || window.canvas.width/2, y: (y || window.canvas.height/2) - 50, text: hypeMsg, color: hypeColor, life: 2.0 }); 
                state.shake = 25; 
            }
        }
        
        // --- 🐾 PET AUTO-STRIKE POWER ---
        let myPet = window.getCurrentPet();
        if (myPet && myPet.class === 'Striker') {
            let triggerCombo = myPet.id === 'pet_e2' ? 15 : 10; 
            if (state.combo > 0 && state.combo % triggerCombo === 0) {
                setTimeout(() => window.petAutoFire(), 500); 
            }
        }
    } else {
        // 💔 COMBO BREAKER & OVERDRIVE SHUTDOWN
        if (state.combo >= 5) { 
            state.floatingTexts.push({ x: window.canvas.width/2, y: window.canvas.height/2, text: "COMBO LOST", color: "#888", life: 1.5 }); 
            window.Sound.error(); 
        }
        
        // Turn off Overdrive if they miss!
        if (state.isOverdrive) {
            document.body.classList.remove("overdrive-active");
            state.isOverdrive = false;
            window.Sound.playTone(100, 'sawtooth', 1.0); // Power down sound
            state.floatingTexts.push({ x: window.canvas.width/2, y: window.canvas.height/2 + 50, text: "OVERDRIVE LOST", color: "#ff0055", life: 1.5 });
        }

        state.combo = 0; 
        elContainer.classList.add("hidden");
    }
};


let rainDrops = [];
window.initRain = function() { if(!bgCanvas) return; bgCanvas.width = window.innerWidth; bgCanvas.height = window.innerHeight; const columns = bgCanvas.width / 20; for(let i=0; i<columns; i++) rainDrops[i] = 1; };
window.drawRain = function() { if(!bgCtx) return; bgCtx.fillStyle = "rgba(2, 2, 5, 0.1)"; bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height); bgCtx.fillStyle = "#00f3ff"; bgCtx.font = "15px 'Orbitron'"; for(let i=0; i<rainDrops.length; i++) { const text = String.fromCharCode(0x30A0 + Math.random() * 96); bgCtx.fillText(text, i*20, rainDrops[i]*20); if(rainDrops[i]*20 > bgCanvas.height && Math.random() > 0.975) rainDrops[i] = 0; rainDrops[i]++; } };
window.triggerGlitch = function(duration = 200) { const overlay = document.getElementById("glitch-overlay"); if(overlay) { overlay.classList.remove("hidden"); if(window.Sound) window.Sound.playTone(Math.random()*500+100, 'sawtooth', 0.1); setTimeout(() => { overlay.classList.add("hidden"); }, duration); } };
window.addEventListener('resize', () => { if(bgCanvas) { bgCanvas.width = window.innerWidth; bgCanvas.height = window.innerHeight; } });
window.addEventListener('load', initRain);

window.handleBossMechanics = function(ctx, boss, time) {
    if (!boss || !boss.isBoss) return;
    
    // --- 1. DARK AURA & ROTATING RINGS ---
    ctx.save(); 
    // Note: CTX is already translated to boss center from drawGame
    
    // Aura Glow
    ctx.shadowBlur = 60;
    ctx.shadowColor = "rgba(255, 0, 50, 0.8)";
    
    // Inner Tech Ring
    ctx.rotate(time / 400); 
    ctx.beginPath(); ctx.arc(0, 0, 200, 0, Math.PI * 1.5); 
    ctx.strokeStyle = `rgba(255, 0, 85, ${0.5 + Math.sin(time/200)*0.4})`; 
    ctx.lineWidth = 5; ctx.stroke();
    
    // Outer Tech Ring
    ctx.beginPath(); ctx.arc(0, 0, 220, Math.PI, Math.PI * 2); 
    ctx.strokeStyle = "rgba(255, 215, 0, 0.5)"; ctx.lineWidth = 3; ctx.stroke(); 
    ctx.restore();

    // --- 2. KIDLAT (LIGHTNING ARCS) ---
    // Random chance to draw lightning around the boss
    if (Math.random() > 0.65) { 
        // We use the helper function already in your code
        // Draw lightning across the boss width
        if(window.drawLightning) {
            window.drawLightning(ctx, 0, 0, 400, 400); 
        }
    }

    // --- 3. ATTACK CYCLE (Charging Laser) ---
    let cycle = time % 5000;
    
    // Charge Phase (3s - 4.5s)
    if (cycle > 3000 && cycle < 4500) { 
        state.bossAttackState.charging = true; 
        state.bossAttackState.firing = false;
        
        // Visuals: Charging Line
        let targetX = window.canvas.width / 2;
        // Since ctx is translated to boss x/y, we need to adjust lineTo logic
        // But for simplicity, we draw relative to boss (0,0)
        
        ctx.save(); 
        ctx.beginPath(); 
        ctx.moveTo(0, 150); // Start from bottom of boss
        // Draw a dashed line downwards
        ctx.lineTo(0, window.canvas.height); 
        ctx.strokeStyle = "rgba(255, 0, 0, 0.4)"; ctx.lineWidth = 2; ctx.setLineDash([20, 20]); ctx.stroke();
        
        // Glowing Orb (Gathering Energy)
        let orbSize = Math.random() * 30 + 20;
        ctx.fillStyle = "rgba(255, 50, 50, 0.9)"; 
        ctx.beginPath(); ctx.arc(0, 150, orbSize, 0, Math.PI*2); ctx.fill(); 
        ctx.shadowBlur = 30; ctx.shadowColor = "red"; ctx.fill();
        ctx.restore();

        if (Math.random() > 0.92) {
            state.floatingTexts.push({ 
                x: boss.x + (Math.random()-0.5)*100, 
                y: boss.y + 200, 
                text: "⚡ CHARGING", 
                color: "#ff0055", 
                life: 0.5 
            });
        }
    } 
    // Fire Phase (4.5s - 4.6s) - BOOM!
    else if (cycle >= 4500 && cycle < 4600) { 
        if (!state.bossAttackState.firing) {
            state.bossAttackState.firing = true; 
            if(window.Sound) window.Sound.nuke(); 
            state.shake = 30; // Stronger Shake
            
            // Damage Player if not shielded (auto hit for drama)
            if (state.gameMode !== 'classroom') {
                state.health -= 5; 
                state.floatingTexts.push({x: window.canvas.width/2, y: window.canvas.height-100, text: "-5 PLASMA BURN", color: "red", life: 2.0}); 
                updateHUD(); 
                if(state.health <= 0) gameOver(); 
            }
        }
        
        // DRAW GIANT LASER
        ctx.save(); 
        ctx.shadowBlur = 60; ctx.shadowColor = "red";
        ctx.beginPath(); ctx.moveTo(0, 150); 
        ctx.lineTo(0, window.canvas.height); // Shoot straight down relative to boss
        
        // Core White Beam
        ctx.strokeStyle = "white"; ctx.lineWidth = 40; ctx.stroke();
        // Outer Red Beam
        ctx.strokeStyle = "rgba(255, 0, 0, 0.6)"; ctx.lineWidth = 70; ctx.stroke(); 
        ctx.restore();
    } 
    else { 
        state.bossAttackState.charging = false; 
        state.bossAttackState.firing = false; 
    }
};
window.showDamage = function(x, y) { let dmg = Math.floor(Math.random() * 100) + 150; state.floatingTexts.push({ x: x, y: y, text: `-${dmg}`, color: "#fff", life: 1.0, isDamage: true }); };

window.initBossShield = function(boss) {
    let n1 = Math.floor(Math.random() * 10) + 1; let n2 = Math.floor(Math.random() * 10) + 1;
    boss.shield = { active: true, hp: 1, q: `${n1} + ${n2}`, a: n1 + n2, maxRadius: 180 };
    state.floatingTexts.push({ x: boss.x, y: boss.y + 100, text: "SHIELD GENERATED!", color: "#00f3ff", life: 2.0 });
};
window.drawBossShield = function(ctx, boss, time) {
    if (!boss.shield || !boss.shield.active) return;
    
   // SA LOOB NG handleBossMechanics, PALITAN ANG DARK MATTER AURA PART:

    // --- 1. DARK MATTER AURA (Rotating Dark Clouds) ---
    ctx.save(); 
    ctx.globalCompositeOperation = 'screen'; // 🟢 GINAWANG SCREEN PARA MAG-GLOW
    let grad = ctx.createRadialGradient(0, 0, 100, 0, 0, 450); // 🟢 PINALAKI ANG SAKOP
    grad.addColorStop(0, "rgba(255, 0, 50, 0.9)"); // Bright Red Core
    grad.addColorStop(1, "rgba(50, 0, 0, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, 450, 0, Math.PI*2); ctx.fill();
    
    // Inner Tech Ring
    ctx.rotate(time / 400); 
    ctx.beginPath(); ctx.arc(0, 0, 250, 0, Math.PI * 1.5); 
    ctx.strokeStyle = `rgba(255, 0, 85, ${0.5 + Math.sin(time/200)*0.4})`; 
    ctx.lineWidth = 10; ctx.stroke();
    
    // Outer Tech Ring
    ctx.beginPath(); ctx.arc(0, 0, 280, Math.PI, Math.PI * 2); 
    ctx.strokeStyle = "rgba(255, 215, 0, 0.5)"; ctx.lineWidth = 3; ctx.stroke(); 
    ctx.restore();

    // 🟢 IMPORTANT: IPATIGIL ANG KIDLAT AT ATTACK KUNG PUMAPASOK PA LANG
    if (boss.isEntering) return; 

    // ... (Yung the rest ng kidlat at attack logic panatilihin lang)
    ctx.shadowBlur = 30;
    ctx.shadowColor = "cyan";

    // Layer 1: Outer Barrier (Pulse)
    let pulse = Math.sin(time / 200) * 5;
    ctx.beginPath();
    ctx.arc(0, 0, 200 + pulse, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0, 255, 255, 0.6)";
    ctx.lineWidth = 3;
    ctx.stroke();

    // Layer 2: Rotating Hexagon Field
    ctx.rotate(time / 1000);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        let angle = (i * Math.PI * 2) / 6;
        let r = 190;
        ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(0, 200, 255, 0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
    
    ctx.restore();
};

window.isVoiceActive = false; window.recognition = null;
window.toggleVoice = function() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { alert("Voice requires Chrome/Edge."); return; }
    if (window.isVoiceActive) { if (window.recognition) window.recognition.stop(); window.isVoiceActive = false; document.getElementById("mic-btn").style.color = "white"; window.Sound.speak("Voice Offline."); return; }
    window.recognition = new SpeechRecognition(); window.recognition.continuous = false; window.recognition.interimResults = false; window.recognition.lang = 'en-US';
    window.recognition.onstart = function() { window.isVoiceActive = true; document.getElementById("mic-btn").style.color = "#00ff41"; };
    window.recognition.onresult = function(event) {
        const t = event.results[0][0].transcript.trim().toLowerCase();
        const numMap = { "zero":0, "one":1, "two":2, "to":2, "too":2, "three":3, "tree":3, "four":4, "for":4, "five":5, "six":6, "seven":7, "eight":8, "ate":8, "nine":9, "ten":10 };
        let finalVal = numMap[t] !== undefined ? numMap[t] : t;
        state.floatingTexts.push({ x: window.canvas.width / 2, y: window.canvas.height - 150, text: `🎤 "${finalVal}"`, color: "#00ff41", life: 1.0 });
        if (state.isPlaying && !state.isPaused) window.fireLaser(finalVal.toString());
    };
    window.recognition.onend = function() { if (window.isVoiceActive && state.isPlaying) window.recognition.start(); else { window.isVoiceActive = false; document.getElementById("mic-btn").style.color = "white"; } };
    window.recognition.start(); window.Sound.speak("Voice Online.");
};

window.generateSmartTip = function(q, userAns = null) {
    if (!q) return "Analyze the pattern.";
    let cleanQ = q.toString().replace(/\s+/g, '');
    let parts = q.match(/(-?\d+)\s*([+\-x÷])\s*(-?\d+)/);
    
    if (cleanQ.includes('=') || (cleanQ.includes('x') && /[a-z]/i.test(cleanQ) && !parts)) {
        if (cleanQ.includes('+')) return "LOGIC: The Plus is a lock. Use MINUS to unlock X.";
        if (cleanQ.includes('-') && !cleanQ.includes('--')) return "LOGIC: The Minus is a gap. Fill it with PLUS to fix X.";
        if (/^\d+x/.test(cleanQ)) return "LOGIC: X is stuck in a group. DIVIDE to break it free.";
        if (cleanQ.includes('/')) return "LOGIC: X is broken. MULTIPLY to make it whole.";
        return "TACTIC: Isolate the unknown. Do the reverse operation.";
    }
    if (!parts) return "Focus on the numbers.";

    let n1 = parseInt(parts[1]); let op = parts[2]; let n2 = parseInt(parts[3]);
    let abs1 = Math.abs(n1); let abs2 = Math.abs(n2);
    
    if (userAns !== null && userAns !== "") {
        let uAns = parseInt(userAns); let correct;
        if(op==='+') correct=n1+n2; else if(op==='-') correct=n1-n2; else if(op==='x') correct=n1*n2; else correct=n1/n2;
        if (uAns === correct) return "EXCELLENT: Perfect execution."; 
        if (op === '+' && uAns === (n1 - n2)) return "DIAGNOSIS: You Subtracted instead of Adding. Look at the Cross (+).";
        if (op === '-' && uAns === (n1 + n2)) return "DIAGNOSIS: You Added instead of Subtracting. Look at the Dash (-).";
        if (op === 'x' && uAns === (n1 + n2)) return "DIAGNOSIS: You Added. 'x' means GROUPS of numbers, not sum.";
        if (Math.abs(uAns) * 10 === Math.abs(correct)) return "DIAGNOSIS: Place Value Error. You missed a Zero at the end.";
        if (Math.abs(uAns) === Math.abs(correct)) return "DIAGNOSIS: Polarity Error. The number is right, but the SIGN is wrong.";
        if (Math.abs(uAns - correct) <= 2) return "DIAGNOSIS: Precision Error. You were incredibly close. Count again.";
    }

    if (op === '+') {
        if ((n1 < 0 && n2 > 0) || (n1 > 0 && n2 < 0)) return "LOGIC: It's a Tug-of-War. Subtract the smaller strength from the bigger one. Winner keeps the sign.";
        if (n1 < 0 && n2 < 0) return "LOGIC: They are allies. Combine their strength, keep the Negative flag.";
        if (abs1 === 9 || abs2 === 9) { let other = (abs1 === 9) ? abs2 : abs1; if (other > 0 && other < 10) return `PATTERN: 9 is greedy. It steals 1 from ${other} to be 10. Result: 1${other-1}.`; }
        if (Math.abs(abs1 - abs2) === 1) { let small = Math.min(abs1, abs2); return `PATTERN: Neighbors. This is just ${small} + ${small} (Doubles), plus 1 extra.`; }
    }
    if (op === '-') {
        if (n2 < 0) return "LOGIC: Subtracting debt is gaining money. Minus-Negative turns into PLUS.";
        if (abs2 === 9) return "TACTIC: Subtracting 9 is annoying. Subtract 10 instead, then give 1 back.";
        if (n1 > n2 && (n1 - n2) <= 4) return `TACTIC: The numbers are neighbors! Don't subtract. Just count UP from ${n2} to ${n1}.`;
    }
    if (op === 'x') {
        if (n1 === 0 || n2 === 0) return "LOGIC: Zero is a black hole. Anything x 0 disappears.";
        if (abs1 === 5 || abs2 === 5) { let even = (abs1 === 5) ? abs2 : abs1; return `PATTERN: 5 is half of 10. Cut ${even} in half, then attach a Zero.`; }
        if (abs1 === 11 || abs2 === 11) return "PATTERN: x11? Split the digits apart, and put their SUM in the middle.";
    }
    return "TACTIC: Breathe. Visualize the groups. You control the numbers.";
};

window.generateTacticalReport = function() {
    const feedbackEl = document.getElementById("ai-feedback"); 
    if (!feedbackEl) return;
    let errorCounts = { '+': 0, '-': 0, 'x': 0, '÷': 0, 'Alg': 0 };
    state.mistakes.forEach(m => { if(m.q.toString().includes('+')) errorCounts['+']++; else if(m.q.toString().includes('x')) errorCounts['x']++; });
    let weakness = Object.keys(errorCounts).reduce((a, b) => errorCounts[a] > errorCounts[b] ? a : b);
    feedbackEl.innerText = `N.E.X.U.S: "Analysis: ${weakness} logic corrupted. Recommendation: Training."`;
    window.Sound.speak("Nexus reports: " + weakness + " logic corrupted.");
};

window.startAITraining = function() {
    // Filter history to remove garbage
    let history = state.gameHistory || [];
    
    if (history.length === 0) { 
        alert("N.E.X.U.S: No combat data found. Engage enemies first."); 
        return; 
    }
    
    // Prioritize WRONG answers, but include CORRECT ones for reinforcement
    // Strategy: Create a training set where mistakes appear 3x more often
    let trainingSet = [];
    history.forEach(item => {
        // Create a simplified object for training
        let qObj = { q: item.q, a: item.a };
        
        if (item.status !== 'correct') {
            // Push mistakes 3 times to increase frequency
            trainingSet.push(qObj);
            trainingSet.push(qObj);
            trainingSet.push(qObj);
        } else {
            // Push correct items once
            trainingSet.push(qObj);
        }
    });
    
    // Shuffle the training set
    trainingSet.sort(() => Math.random() - 0.5);
    
    // Use the existing 'mistakes' variable as the queue (dirty but works with existing nextTrainingQuestion logic)
    state.mistakes = trainingSet; 
    
    document.getElementById("report-modal").classList.add("hidden");
    document.getElementById("training-modal").classList.remove("hidden");
    state.training.active = true;
    window.nextTrainingQuestion();
};

window.nextTrainingQuestion = function() {
    if (state.mistakes.length === 0) { window.closeTraining(); return; }
    let mistake = state.mistakes[Math.floor(Math.random() * state.mistakes.length)];
    let qText = mistake.q; let correctAnswer = mistake.a;
    let options = [correctAnswer];
    while (options.length < 4) {
        let wrong = correctAnswer + (Math.floor(Math.random() * 10) - 5);
        if (wrong !== correctAnswer && !options.includes(wrong)) options.push(wrong);
    }
    options.sort(() => Math.random() - 0.5);
    document.getElementById("train-q").innerText = qText;
    document.getElementById("ai-tip-box").classList.add("hidden");
    let grid = document.getElementById("ai-options-grid"); grid.innerHTML = "";
    options.forEach(opt => {
        let btn = document.createElement("button"); btn.className = "btn secondary"; btn.style.margin = "0";
        btn.innerText = opt; btn.onclick = () => window.checkTrainingAnswer(opt, correctAnswer, qText);
        grid.appendChild(btn);
    });
};

window.checkTrainingAnswer = function(selected, correct, question) {
    if (selected === correct) {
        window.Sound.powerup(); 
        state.mistakes.splice(state.training.currentIdx, 1);
        if (state.mistakes.length === 0) { alert("Protocol Complete. All errors corrected."); window.closeTraining(); } 
        else { window.nextTrainingQuestion(); }
    } else {
        window.Sound.error();
        document.getElementById("ai-tip-box").classList.remove("hidden");
        document.getElementById("train-tip").innerText = window.generateSmartTip(question, selected);
    }
};
window.closeTraining = function() { 
    if(window.Sound) window.Sound.click();
    
    // 1. Itago ang Training Simulation
    const trainModal = document.getElementById("training-modal");
    if(trainModal) trainModal.classList.add("hidden"); 
    
    state.training.active = false; 
    
    // 2. SMART ROUTING: Ipakita ulit ang Report Modal (Mission Debrief)
    const reportModal = document.getElementById("report-modal");
    if (reportModal) {
        reportModal.classList.remove("hidden");
    }
    
    // Optional: Kung gusto mong palitan ang text ng button para alam nilang tapos na sila mag-train
    const aiBtn = document.querySelector('button[onclick*="startAITraining"]');
    if(aiBtn) {
        aiBtn.innerText = "✅ TRAINING COMPLETE";
        aiBtn.disabled = true; // Disable muna para hindi spam
        aiBtn.style.opacity = "0.5";
    }
};
// ==========================================
// 👨‍🏫 TEACHER DASHBOARD LOGIC (FINAL)
// ==========================================

let dashboardUnsub = null;
let currentStudentData = []; 

// --- AUTO COUNTDOWN ---
window.startIntermissionCountdown = function(nextRound) {
    if (isAutoStarting) return;
    
    console.log("Countdown Started");
    isAutoStarting = true;
    intermissionSeconds = 10; 

    // UI Initial Update for Timer Mode
    const startBtn = document.getElementById('btn-start-round');
    const stopBtn = document.getElementById('btn-stop-round');
    
    if(stopBtn) {
        stopBtn.innerText = "⏸ PAUSE TIMER";
        stopBtn.className = "btn secondary";
        stopBtn.onclick = window.pauseIntermissionTimer;
    }

    if (autoStartTimer) clearInterval(autoStartTimer);
    
    autoStartTimer = setInterval(() => {
        intermissionSeconds--;
        
        if (startBtn) {
            startBtn.innerText = `⏳ AUTO-START: ${intermissionSeconds}s`;
            startBtn.classList.add('pulse-btn');
            startBtn.onclick = () => {
                // Manual Click Override
                clearInterval(autoStartTimer);
                window.adminStartRound(); 
            };
        }

        if (intermissionSeconds <= 0) {
            clearInterval(autoStartTimer);
            window.adminStartRound(); // Auto-fire
        }
    }, 1000);
};

window.pauseIntermissionTimer = function() {
    if (autoStartTimer) clearInterval(autoStartTimer);
    autoStartTimer = null;
    isAutoStarting = false; 
    
    // UI Update: Back to Manual Mode
    const startBtn = document.getElementById('btn-start-round');
    const stopBtn = document.getElementById('btn-stop-round');
    
    if(startBtn) {
        startBtn.innerText = "▶ START NEXT ROUND";
        startBtn.classList.remove('pulse-btn');
        startBtn.onclick = window.adminStartRound;
    }
    if(stopBtn) {
        stopBtn.innerText = "❌ END CLASS";
        stopBtn.className = "btn danger";
        stopBtn.onclick = window.adminForceStop;
    }
};

// --- START ROUND ---
window.adminStartRound = async function() {
    // 1. Clean Timers
    if (typeof autoStartTimer !== 'undefined' && autoStartTimer) {
        clearInterval(autoStartTimer);
        autoStartTimer = null;
    }
    isAutoStarting = false;
    intermissionSeconds = 10; // Reset for next time

    if(!currentRoomId) return;
    
    const roomRef = doc(db, "rooms", currentRoomId);
    const snap = await getDoc(roomRef);
    if(!snap.exists()) return;
    
    let data = snap.data();
    // ParseInt is crucial for math
    let nextRound = (parseInt(data.currentRound) || 0) + 1;
    let max = parseInt(data.maxRounds) || 1;

    if (nextRound > max) {
        alert("ALL ROUNDS COMPLETED!");
        return;
    }

    if(window.Sound) window.Sound.powerup();
    
    // 2. Update DB -> This triggers monitorClassroom to update UI
    await updateDoc(roomRef, { 
        status: 'playing', 
        startTime: Date.now(),
        currentRound: nextRound
    });
};

window.adminForceStop = async function() {
    if(!currentRoomId) return;
    
    const btn = document.getElementById('btn-stop-round');
    // Check if we are really ending the class or just the round
    const isEndingClass = btn && (btn.innerText.includes("END CLASS") || btn.innerText.includes("EXIT"));
    
    let msg = isEndingClass ? "END THE ENTIRE CLASS SESSION?" : "STOP CURRENT ROUND?";
    
    if(!confirm(msg)) return;
    if(window.Sound) window.Sound.error();

    // Kill any running timers immediately
    if (typeof autoStartTimer !== 'undefined') { clearInterval(autoStartTimer); }
    isAutoStarting = false;
    intermissionSeconds = 10; // Reset timer for next usage

    const roomRef = doc(db, "rooms", currentRoomId);
    const snap = await getDoc(roomRef);

    if (snap.exists()) {
        const data = snap.data();
        const currentR = parseInt(data.currentRound || 0);
        const maxR = parseInt(data.maxRounds || 1);

        // Logic: Kung may rounds pa, at hindi "End Class" ang pinindot -> Intermission
        if (currentR < maxR && !isEndingClass) {
            await updateDoc(roomRef, { status: 'round_ended' });
        } else {
            // Otherwise, Tapos na talaga
            await updateDoc(roomRef, { status: 'finished' });
        }
    }
};

// --- FREEZE ALL ---
window.adminFreezeAll = async function() {
    if(!currentRoomId) return;
    const btn = document.getElementById('btn-freeze-toggle');
    const isFrozen = btn.innerText.includes("RESUME");

    if (isFrozen) {
        await updateDoc(doc(db, "rooms", currentRoomId), { status: 'playing' });
    } else {
        await updateDoc(doc(db, "rooms", currentRoomId), { status: 'frozen' });
    }
};
window.lastRoomStatus = 'waiting';


// NEW VIEW: CLASS ROSTER (For Lobby)
// ==========================================
// 📡 GOD-LEVEL TEACHER VIEW RENDERERS
// ==========================================

// 1. LIVE ROSTER (Holographic Fleet)
window.updateRosterView = function() {
    const container = document.getElementById('roster-grid');
    if(!container) return;

    container.innerHTML = "";
    if (currentStudentData.length === 0) {
        container.innerHTML = `<div style="grid-column: 1/-1; text-align:center; color:#00e5ff; padding:50px; font-family:'Orbitron'; letter-spacing:5px;" class="blink">AWAITING AGENT UPLINK...</div>`;
        return;
    }

    currentStudentData.forEach(s => {
        // Create an animated sound wave for active connection
        let soundWave = `<div class="sound-wave" style="height:20px;">
            <div class="bar" style="background:#00ff41;"></div>
            <div class="bar" style="background:#00ff41;"></div>
            <div class="bar" style="background:#00ff41;"></div>
        </div>`;

        const card = document.createElement('div');
        card.className = 'roster-card-god';
        card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-size:10px; color:#00ff41; font-family:'Courier New'; margin-bottom:5px;">ID: ${s.uid ? s.uid.substring(0,6).toUpperCase() : 'AGNT-01'}</div>
                    <h4 style="margin:0; color:white; font-family:'Orbitron'; font-size:22px; text-shadow:0 0 10px rgba(255,255,255,0.5);">${s.name}</h4>
                </div>
                ${soundWave}
            </div>
            <div style="margin-top:15px; border-top:1px dashed rgba(0,255,65,0.3); padding-top:10px; display:flex; justify-content:space-between;">
                <span style="font-size:11px; color:#00ff41; font-family:'Rajdhani'; font-weight:bold;">● SECURE CONNECTION</span>
                <span style="font-size:11px; color:#aaa;">PING: <span style="color:#00e5ff;">${Math.floor(Math.random() * 20 + 10)}ms</span></span>
            </div>
        `;
        container.appendChild(card);
    });
};

// ==========================================
// 👁️‍🗨️ N.E.X.U.S. SPY GRID (DECOUPLED ENGINE)
// ==========================================
window.agentTelemetry = window.agentTelemetry || {};

window.updateSpyView = function() {
    const grid = document.getElementById('spy-grid-container');
    if(!grid || document.getElementById('view-grid').classList.contains('hidden')) return;

    const now = Date.now();

    currentStudentData.forEach(s => {
        let safeId = (s.uid || s.name).replace(/[^a-zA-Z0-9]/g, '_');
        let card = document.getElementById(`card-${safeId}`);

        // 1. NON-DESTRUCTIVE INJECTION: Gagawa lang ng card kung wala pa!
        if (!card) {
            let avatarUrl = s.avatar || "https://img.icons8.com/color/96/000000/astronaut.png";
            let newCardHTML = `
                <div class="tel-card" id="card-${safeId}">
                    <div class="tel-header">
                        <div class="tel-agent-info">
                            <img src="${avatarUrl}" class="tel-avatar">
                            <div>
                                <h4 class="tel-name">${s.name}</h4>
                                <div class="tel-status" id="status-${safeId}">● SCANNING</div>
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-family:'Orbitron'; font-size:10px; color:#888;">HP INTEGRITY</div>
                            <div id="hp-${safeId}" style="font-family:'Rajdhani'; font-size:18px; font-weight:bold;">100%</div>
                        </div>
                    </div>

                    <div class="tel-graph-container">
                        <div class="tel-graph-grid"></div>
                        <canvas id="canvas-${safeId}" width="320" height="70"></canvas>
                    </div>

                    <div class="tel-stats-strip">
                        <div class="tel-stat-block">
                            <span class="tel-stat-label">ACCURACY</span>
                            <span class="tel-stat-val" id="acc-${safeId}">100%</span>
                        </div>
                        <div class="tel-stat-block" style="border-left: 1px solid #223; border-right: 1px solid #223;">
                            <span class="tel-stat-label">COMBO</span>
                            <span class="tel-stat-val" id="combo-${safeId}">x0</span>
                        </div>
                        <div class="tel-stat-block">
                            <span class="tel-stat-label">SCORE</span>
                            <span class="tel-stat-val" id="score-${safeId}" style="color:#ffd700;">0</span>
                        </div>
                    </div>

                    <div class="tel-footer" style="margin-top: 10px;">
                        <div>INPUT: <span id="input-${safeId}">[ AWAITING ]</span></div>
                        <div id="weakness-${safeId}" style="color:#b000ff; font-weight:bold;">NONE</div>
                    </div>
                </div>
            `;
            grid.insertAdjacentHTML('beforeend', newCardHTML);
            card = document.getElementById(`card-${safeId}`);
            
            // Initialize graph arrays
            window.agentTelemetry[safeId] = { history: Array(30).fill(0), latestScore: 0 };
        }

        // 2. UPDATE DOM TEXTS (Update numbers only, no HTML wipe)
        let isOffline = s.lastActive && (now - s.lastActive > 15000) && s.status !== 'finished';
        let isFrozen = s.inputLocked; 
        
        let themeColor = '#00e5ff'; let themeGlow = 'rgba(0, 229, 255, 0.3)'; let statusText = 'COMBAT READY';
        if (isOffline) { themeColor = '#555'; themeGlow = 'transparent'; statusText = 'SIGNAL LOST'; }
        else if (s.status === 'finished') { themeColor = '#ffd700'; themeGlow = 'rgba(255, 215, 0, 0.4)'; statusText = 'EXTRACTED'; }
        else if (isFrozen) { themeColor = '#ff0055'; themeGlow = 'rgba(255, 0, 85, 0.3)'; statusText = 'SYSTEM JAMMED'; }
        else if ((s.health || 100) <= 30) { themeColor = '#ff0055'; themeGlow = 'rgba(255, 0, 85, 0.4)'; statusText = 'HULL CRITICAL'; }
        else if ((s.combo || 0) >= 10) { themeColor = '#ffd700'; themeGlow = 'rgba(255, 215, 0, 0.4)'; statusText = 'OVERDRIVE ACTIVE'; }

        card.style.setProperty('--card-theme', themeColor);
        card.style.opacity = isOffline ? '0.6' : '1';

        const statusEl = document.getElementById(`status-${safeId}`);
        if(statusEl) {
            statusEl.innerText = `● ${statusText}`;
            statusEl.style.color = themeColor;
            statusEl.className = `tel-status ${(!isOffline && !isFrozen && s.status !== 'finished') ? 'blink' : ''}`;
        }
        
        const hpEl = document.getElementById(`hp-${safeId}`);
        if(hpEl) {
            hpEl.innerText = `${s.health || 100}%`;
            hpEl.style.color = (s.health || 100) <= 30 ? '#ff0055' : '#00ff41';
        }
        
        const comboEl = document.getElementById(`combo-${safeId}`);
        if(comboEl) {
            comboEl.innerText = `x${s.combo || 0}`;
            if((s.combo || 0) >= 10) comboEl.classList.add('tel-combo-pulse'); else comboEl.classList.remove('tel-combo-pulse');
        }
        
        const scoreEl = document.getElementById(`score-${safeId}`);
        if(scoreEl) scoreEl.innerText = s.currentScore || 0;
        
        const inputEl = document.getElementById(`input-${safeId}`);
        if(inputEl) inputEl.innerText = isOffline ? 'OFFLINE' : (s.lastAnswer || 'EMPTY');
        
        const weakEl = document.getElementById(`weakness-${safeId}`);
        if(weakEl) weakEl.innerText = s.weakestLink ? s.weakestLink.toUpperCase() : 'NONE';
        
        const accEl = document.getElementById(`acc-${safeId}`);
        if(accEl) {
            accEl.innerText = `${s.accuracy || 100}%`;
            accEl.style.color = (s.accuracy || 100) >= 80 ? '#00ff41' : ((s.accuracy || 100) >= 50 ? '#ffd700' : '#ff0055');
        }

        // 3. STORE LATEST SCORE FOR GRAPH ENGINE
        if (window.agentTelemetry[safeId]) {
            window.agentTelemetry[safeId].latestScore = s.currentScore || 0;
            window.agentTelemetry[safeId].themeColor = themeColor;
            window.agentTelemetry[safeId].isOffline = isOffline;
        }
    });
};

// 🟢 THE GRAPH ENGINE: Tumatakbo mag-isa every 2 seconds para smooth ang drawing!
if(!window.spyGraphInterval) {
    window.spyGraphInterval = setInterval(() => {
        const gridHidden = document.getElementById('view-grid')?.classList.contains('hidden');
        if (gridHidden || !currentStudentData) return; 

        currentStudentData.forEach(s => {
            let safeId = (s.uid || s.name).replace(/[^a-zA-Z0-9]/g, '_');
            let tel = window.agentTelemetry[safeId];
            if (!tel) return;

            tel.history.push(tel.latestScore);
            if (tel.history.length > 30) tel.history.shift();

            let canvas = document.getElementById(`canvas-${safeId}`);
            if (canvas && !tel.isOffline) {
                let ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                
                // Baseline
                ctx.strokeStyle = "rgba(255,255,255,0.05)";
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(0, canvas.height - 5); ctx.lineTo(canvas.width, canvas.height - 5); ctx.stroke();

                // Draw Line
                ctx.beginPath();
                let step = canvas.width / 29;
                let maxScoreInHistory = Math.max(...tel.history, 50); 
                
                ctx.strokeStyle = tel.themeColor || "#00e5ff"; 
                ctx.lineWidth = 3; 
                ctx.shadowBlur = 10; 
                ctx.shadowColor = tel.themeColor || "#00e5ff";
                
                for (let i = 0; i < tel.history.length; i++) {
                    let x = i * step;
                    let y = (canvas.height - 10) - ((tel.history[i] / maxScoreInHistory) * (canvas.height - 20));
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.stroke();

                // Glowing Lead Dot
                let lastX = (tel.history.length - 1) * step;
                let lastY = (canvas.height - 10) - ((tel.history[tel.history.length - 1] / maxScoreInHistory) * (canvas.height - 20));
                ctx.beginPath(); ctx.arc(lastX, lastY, 4, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
            }
        });
    }, 2000);
}

// ==========================================
// 📄 DATA REPORTS (RESPONSIVE TABLE)
// ==========================================
window.updateReportView = function() {
    const tbody = document.getElementById('report-list-body'); 
    if(!tbody) return;

    currentStudentData.sort((a, b) => {
        if (a.needsHelp && !b.needsHelp) return -1; // SOS alerts on top
        if (!a.needsHelp && b.needsHelp) return 1;
        return (b.totalScore || 0) - (a.totalScore || 0); // Then sort by score
    });

    tbody.innerHTML = "";
    const now = Date.now();
    let classTotalScore = 0; let classTotalAcc = 0;
    let activeAgentsCount = 0;

    currentStudentData.forEach(s => {
        classTotalScore += (s.totalScore || 0);
        if(s.roundsPlayed > 0) {
            classTotalAcc += (s.accuracy || 100);
            activeAgentsCount++;
        }

        let statusBadge = `<span style="background:rgba(0,255,65,0.2); color:#00ff41; padding:6px 12px; border-radius:4px; font-weight:bold; font-size:12px; border:1px solid #00ff41;">ONLINE</span>`;
        let rowClass = "report-row-god";

        if (s.lastActive && (now - s.lastActive > 15000) && s.status !== 'finished') {
            statusBadge = `<span style="background:rgba(100,100,100,0.2); color:#888; padding:6px 12px; border-radius:4px; font-weight:bold; font-size:12px; border:1px solid #555;">OFFLINE</span>`;
            rowClass = "report-row-god opacity-50";
        } else if (s.status === 'finished') {
            statusBadge = `<span style="background:rgba(0,229,255,0.2); color:#00e5ff; padding:6px 12px; border-radius:4px; font-weight:bold; font-size:12px; border:1px solid #00e5ff;">EXTRACTED</span>`;
        } else if (s.needsHelp) {
            statusBadge = `<span class="blink" style="background:rgba(255,0,85,0.2); color:#ff0055; padding:6px 12px; border-radius:4px; font-weight:bold; font-size:12px; border:1px solid #ff0055;">SOS ALERT</span>`;
            rowClass = "report-row-god on-fire-row"; 
        }

        let accColor = (s.accuracy || 100) < 60 ? '#ff0055' : ((s.accuracy || 100) < 85 ? '#ffd700' : '#00ff41');

        tbody.innerHTML += `
            <tr class="${rowClass}">
                <td style="padding:15px; font-family:'Orbitron'; font-size:16px; color:white; font-weight:bold;">${s.name}</td>
                <td style="padding:15px; text-align:center; color:#aaa; font-family:'Courier New';">${s.roundsPlayed || 0}</td>
                <td style="padding:15px; text-align:center; font-family:'Orbitron'; font-weight:bold; color:#ffd700; font-size:18px;">${s.totalScore || 0}</td>
                <td style="padding:15px; text-align:center; color:${accColor}; font-weight:bold; font-size:18px;">${s.accuracy || 100}%</td>
                <td style="padding:15px; text-align:center;">${statusBadge}</td>
                <td style="padding:15px; text-align:center;">
                    <button class="btn secondary" style="padding: 8px 15px; font-size: 11px; border-color: #00e5ff; color: #00e5ff; box-shadow:0 0 10px rgba(0,229,255,0.2); margin:0;" 
                    onclick="window.generateInterventionReport('${s.name}', '${s.accuracy || 100}', '${s.weakestLink || 'N/A'}')">
                    🔍 DOSSIER
                    </button>
                </td>
            </tr>`;
    });

    let avgScore = activeAgentsCount > 0 ? Math.floor(classTotalScore / activeAgentsCount) : 0;
    let avgAcc = activeAgentsCount > 0 ? Math.floor(classTotalAcc / activeAgentsCount) : 0;
    
    const avgScoreEl = document.getElementById('rep-avg-score');
    const avgAccEl = document.getElementById('rep-avg-acc');
    if (avgScoreEl) avgScoreEl.innerText = avgScore;
    if (avgAccEl) {
        avgAccEl.innerText = avgAcc + "%";
        avgAccEl.style.color = avgAcc < 60 ? "#ff0055" : "#00ff41";
    }
};

// 🟢 THE GRAPH ENGINE: Tumatakbo mag-isa every 2 seconds para smooth ang drawing!
window.startSpyGraphEngine = function() {
    if (window.spyGraphInterval) clearInterval(window.spyGraphInterval);
    
    window.spyGraphInterval = setInterval(() => {
        const gridHidden = document.getElementById('view-grid')?.classList.contains('hidden');
        if (gridHidden || !currentStudentData) return; // Wag mag-draw kung nakatago ang tab

        currentStudentData.forEach(s => {
            let safeId = (s.uid || s.name).replace(/[^a-zA-Z0-9]/g, '_');
            let tel = window.agentTelemetry[safeId];
            if (!tel) return;

            // Push the latest score to history array smoothly
            tel.history.push(tel.latestScore);
            if (tel.history.length > 30) tel.history.shift();

            let canvas = document.getElementById(`canvas-${safeId}`);
            if (canvas && !tel.isOffline) {
                let ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                
                // Baseline
                ctx.strokeStyle = "rgba(255,255,255,0.05)";
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(0, canvas.height - 5); ctx.lineTo(canvas.width, canvas.height - 5); ctx.stroke();

                // Draw Line
                ctx.beginPath();
                let step = canvas.width / 29;
                let maxScoreInHistory = Math.max(...tel.history, 50); // Dynamic height scaling
                
                ctx.strokeStyle = tel.themeColor || "#00e5ff"; 
                ctx.lineWidth = 3; 
                ctx.shadowBlur = 10; 
                ctx.shadowColor = tel.themeColor || "#00e5ff";
                
                for (let i = 0; i < tel.history.length; i++) {
                    let x = i * step;
                    let y = (canvas.height - 10) - ((tel.history[i] / maxScoreInHistory) * (canvas.height - 20));
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.stroke();

                // Glowing Lead Dot
                let lastX = (tel.history.length - 1) * step;
                let lastY = (canvas.height - 10) - ((tel.history[tel.history.length - 1] / maxScoreInHistory) * (canvas.height - 20));
                ctx.beginPath(); ctx.arc(lastX, lastY, 4, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
            }
        });
    }, 2000);
};

// Placeholder for the Teacher Action Buttons (To be programmed later)
window.teacherAction = function(actionType, targetUid) {
    if(window.Sound) window.Sound.click();
    console.log(`[COMMANDER ACTION]: Triggering ${actionType} on Agent ${targetUid}`);
    // Iko-konekta natin ito sa Socket.io mamaya!
};

// 🎮 CCTV MODAL CONTROLS (Ito yung magbubukas nung malaking TV)
window.currentWatchTarget = null;
window.isBeingWatched = false; 

window.watchStudentLive = function(targetUid, targetName) {
    if(window.Sound) window.Sound.click();
    window.currentWatchTarget = targetUid;
    
    document.getElementById("cctv-target-name").innerText = targetName;
    document.getElementById("cctv-modal").classList.remove("hidden");
    document.getElementById("live-cctv-screen").src = ""; // Clear old image
    document.getElementById("cctv-loading-text").style.display = "block"; // Show loading text
    
    // Uutusan ng Teacher ang Server na gisingin ang camera ni Student!
    if(socket) socket.emit('request_stream', { room: currentRoomId, targetUid: targetUid });
};

window.closeCCTV = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("cctv-modal").classList.add("hidden");
    
    // Uutusan ng Teacher ang Server na patayin ang camera ni Student para tipid data!
    if(socket && window.currentWatchTarget) {
        socket.emit('stop_stream', { room: currentRoomId, targetUid: window.currentWatchTarget });
    }
    window.currentWatchTarget = null;
    document.getElementById("live-cctv-screen").src = "";
};

// ==========================================
// 👑 THE N.E.X.U.S. GOD-TIER RANKINGS ENGINE
// ==========================================
window.updatePodiumView = function() {
    const viewContainer = document.getElementById('view-podium');
    if(!viewContainer || viewContainer.classList.contains('hidden')) return;
    
    // Safety check kung may laman o wala pang students
    const p1 = currentStudentData[0] || {name: 'NO SIGNAL', totalScore: 0};
    const p2 = currentStudentData[1] || {name: 'NO SIGNAL', totalScore: 0};
    const p3 = currentStudentData[2] || {name: 'NO SIGNAL', totalScore: 0};

    // Update Top 3 Direct Elements
    document.getElementById('p1-name').innerText = p1.name; 
    document.getElementById('p1-score').innerHTML = `${p1.totalScore} <span>PTS</span>`;
    
    document.getElementById('p2-name').innerText = p2.name; 
    document.getElementById('p2-score').innerHTML = `${p2.totalScore} <span>PTS</span>`;
    
    document.getElementById('p3-name').innerText = p3.name; 
    document.getElementById('p3-score').innerHTML = `${p3.totalScore} <span>PTS</span>`;

    // 🟢 RUNNER-UPS LIST INJECTION (Rank 4 onwards)
    const listBody = document.getElementById('podium-list-body');
    if(listBody) {
        listBody.innerHTML = ""; // Clear old list
        
        if (currentStudentData.length <= 3) {
            listBody.innerHTML = `<div style="text-align:center; color:#556; font-family:'Orbitron'; padding:20px; letter-spacing: 2px;">NO ADDITIONAL DATA DETECTED</div>`;
            return;
        }

        let listHTML = "";
        for(let i=3; i<currentStudentData.length; i++) {
            let s = currentStudentData[i];
            let rankNum = (i + 1).toString().padStart(2, '0'); // Para maging "04", "05"
            
            listHTML += `
            <div class="nexus-list-row">
                <div class="nexus-row-rank">${rankNum}</div>
                <div class="nexus-row-name">${s.name}</div>
                <div class="nexus-row-score">${s.totalScore || 0} PTS</div>
            </div>`;
        }
        listBody.innerHTML = listHTML;
    }
};

// Siguraduhing may emitter din sa loob ng gameLoop!
// Hanapin ang parteng ito sa gameLoop mo at siguraduhing tama ang variable name (window.myDocId):
// socket.emit('spy_cam_frame', { room: currentRoomId, uid: window.myDocId || myName, frame: frameData });
// 🎮 CCTV MODAL CONTROLLERS
window.currentWatchTarget = null;
window.isBeingWatched = false; // Flag for student side

window.watchStudentLive = function(targetUid, targetName) {
    if(window.Sound) window.Sound.click();
    window.currentWatchTarget = targetUid;
    
    // Setup Modal UI
    document.getElementById("cctv-target-name").innerText = targetName;
    document.getElementById("cctv-modal").classList.remove("hidden");
    document.getElementById("live-cctv-screen").src = ""; // Clear old image
    document.getElementById("cctv-loading-text").style.display = "block"; // Show loader
    
    // Emit signal to server to WAKE UP the student's stream
    if(socket) socket.emit('request_stream', { room: currentRoomId, targetUid: targetUid });
};

window.closeCCTV = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("cctv-modal").classList.add("hidden");
    
    // Tell the student they can stop streaming now to save bandwidth
    if(socket && window.currentWatchTarget) {
        socket.emit('stop_stream', { room: currentRoomId, targetUid: window.currentWatchTarget });
    }
    window.currentWatchTarget = null;
    document.getElementById("live-cctv-screen").src = "";
};

// ==========================================
// 📄 DATA REPORTS (RESPONSIVE TABLE)
// ==========================================
window.updateReportView = function() {
    const tbody = document.getElementById('report-list-body'); 
    if(!tbody) return;

    currentStudentData.sort((a, b) => {
        if (a.needsHelp && !b.needsHelp) return -1; // SOS alerts on top
        if (!a.needsHelp && b.needsHelp) return 1;
        return (b.totalScore || 0) - (a.totalScore || 0); // Then sort by score
    });

    tbody.innerHTML = "";
    const now = Date.now();
    let classTotalScore = 0; let classTotalAcc = 0;
    let activeAgentsCount = 0;

    currentStudentData.forEach(s => {
        classTotalScore += (s.totalScore || 0);
        if(s.roundsPlayed > 0) {
            classTotalAcc += (s.accuracy || 100);
            activeAgentsCount++;
        }

        let statusBadge = `<span style="background:rgba(0,255,65,0.2); color:#00ff41; padding:6px 12px; border-radius:4px; font-weight:bold; font-size:12px; border:1px solid #00ff41;">ONLINE</span>`;
        let rowClass = "report-row-god";

        if (s.lastActive && (now - s.lastActive > 15000) && s.status !== 'finished') {
            statusBadge = `<span style="background:rgba(100,100,100,0.2); color:#888; padding:6px 12px; border-radius:4px; font-weight:bold; font-size:12px; border:1px solid #555;">OFFLINE</span>`;
            rowClass = "report-row-god opacity-50";
        } else if (s.status === 'finished') {
            statusBadge = `<span style="background:rgba(0,229,255,0.2); color:#00e5ff; padding:6px 12px; border-radius:4px; font-weight:bold; font-size:12px; border:1px solid #00e5ff;">EXTRACTED</span>`;
        } else if (s.needsHelp) {
            statusBadge = `<span class="blink" style="background:rgba(255,0,85,0.2); color:#ff0055; padding:6px 12px; border-radius:4px; font-weight:bold; font-size:12px; border:1px solid #ff0055;">SOS ALERT</span>`;
            rowClass = "report-row-god on-fire-row"; 
        }

        let accColor = (s.accuracy || 100) < 60 ? '#ff0055' : ((s.accuracy || 100) < 85 ? '#ffd700' : '#00ff41');

        tbody.innerHTML += `
            <tr class="${rowClass}">
                <td style="padding:18px 20px; font-family:'Orbitron'; font-size:18px; color:white; font-weight:bold;">${s.name}</td>
                <td style="padding:18px 20px; text-align:center; color:#aaa; font-family:'Courier New';">${s.roundsPlayed || 0}</td>
                <td style="padding:18px 20px; text-align:center; font-family:'Orbitron'; font-weight:bold; color:#ffd700; font-size:22px;">${s.totalScore || 0}</td>
                <td style="padding:18px 20px; text-align:center; color:${accColor}; font-weight:bold; font-size:20px;">${s.accuracy || 100}%</td>
                <td style="padding:18px 20px; text-align:center;">${statusBadge}</td>
                <td style="padding:18px 20px; text-align:center;">
                    <button class="btn secondary" style="padding: 10px 20px; font-size: 12px; border-color: #00e5ff; color: #00e5ff; box-shadow:0 0 10px rgba(0,229,255,0.2); margin:0;" 
                    onclick="window.generateInterventionReport('${s.name}', '${s.accuracy || 100}', '${s.weakestLink || 'N/A'}')">
                    🔍 DOSSIER
                    </button>
                </td>
            </tr>`;
    });

    // Smart Averages (Avoid dividing by zero)
    let avgScore = activeAgentsCount > 0 ? Math.floor(classTotalScore / activeAgentsCount) : 0;
    let avgAcc = activeAgentsCount > 0 ? Math.floor(classTotalAcc / activeAgentsCount) : 0;
    
    const avgScoreEl = document.getElementById('rep-avg-score');
    const avgAccEl = document.getElementById('rep-avg-acc');
    if (avgScoreEl) avgScoreEl.innerText = avgScore;
    if (avgAccEl) {
        avgAccEl.innerText = avgAcc + "%";
        avgAccEl.style.color = avgAcc < 60 ? "#ff0055" : "#00ff41";
    }
};

// 5. ADMIN CONTROLS (FIXED: 3-Button Layout)
window.adminStartRound = async function() {
    // --- 1. CLEANUP TIMER ---
    if (typeof autoStartTimer !== 'undefined' && autoStartTimer) {
        clearInterval(autoStartTimer);
        autoStartTimer = null;
    }
    if (typeof isAutoStarting !== 'undefined') isAutoStarting = false;

    // --- 2. UI UPDATE ---
    const startBtn = document.getElementById('btn-start-round');
    const freezeBtn = document.getElementById('btn-freeze-toggle');
    const stopBtn = document.getElementById('btn-stop-round');

    // Reset Start Button
    if(startBtn) {
        startBtn.classList.remove('pulse-btn');
    }

    // Show Freeze Button & Reset Text
    if(freezeBtn) {
        freezeBtn.classList.remove('hidden');
        freezeBtn.innerText = "❄️ FREEZE";
        freezeBtn.classList.remove('primary'); // Ensure blue style
        freezeBtn.classList.add('secondary');
    }
    
    // Ensure Stop Button is visible and RED
    if(stopBtn) {
        stopBtn.classList.remove('hidden');
        stopBtn.innerText = "⏹ STOP ROUND";
        stopBtn.disabled = false;
    }

    // --- 3. START GAME LOGIC ---
    if(!currentRoomId) return;
    
    const roomRef = doc(db, "rooms", currentRoomId);
    const snap = await getDoc(roomRef);
    if(!snap.exists()) return;
    
    let data = snap.data();
    let nextRound = (parseInt(data.currentRound) || 0) + 1;
    let max = parseInt(data.maxRounds) || 1;

    if (nextRound > max) {
        alert("ALL ROUNDS COMPLETED!");
        return;
    }

    if(window.Sound) window.Sound.powerup();
    
    // Update DB
    await updateDoc(roomRef, { 
        status: 'playing', 
        startTime: Date.now(),
        currentRound: nextRound
    });
    
    // Disable Start Button while playing
    if(startBtn) { 
        startBtn.innerText = `⏳ ROUND ${nextRound} / ${max}`; 
        startBtn.disabled = true; 
        startBtn.style.opacity = "0.5"; 
    }
};

window.adminFreezeAll = async function() {
    if(!currentRoomId) return;
    
    const btn = document.getElementById('btn-freeze-toggle');
    const isCurrentlyFrozen = btn.innerText.includes("RESUME");
    
    if (isCurrentlyFrozen) {
        // RESUME
        if(window.Sound) window.Sound.click();
        await updateDoc(doc(db, "rooms", currentRoomId), { status: 'playing' });
        
        btn.innerText = "❄️ FREEZE";
        btn.classList.remove('primary');
        btn.classList.add('secondary'); // Blue style
        btn.style.boxShadow = "none";
    } else {
        // FREEZE
        if(window.Sound) window.Sound.error();
        await updateDoc(doc(db, "rooms", currentRoomId), { status: 'frozen' });
        
        btn.innerText = "▶ RESUME";
        btn.classList.remove('secondary');
        btn.classList.add('primary'); // Highlight style
        btn.style.boxShadow = "0 0 15px #00e5ff";
    }
};
window.adminForceStop = async function() {
    if(!currentRoomId) return;
    if(!confirm("END the current round?")) return; // Confirmation
    if(window.Sound) window.Sound.error();
    
    const roomRef = doc(db, "rooms", currentRoomId);
    const snap = await getDoc(roomRef);
    
    if (snap.exists()) {
        const data = snap.data();
        // 🚨 FIX: ParseInt para hindi malito sa string/number comparison
        const currentR = parseInt(data.currentRound || 0);
        const maxR = parseInt(data.maxRounds || 1);
        
        // Hide Freeze Button (Not needed during intermission)
        const freezeBtn = document.getElementById('btn-freeze-toggle');
        if(freezeBtn) freezeBtn.classList.add('hidden');

        if (currentR < maxR) {
            // === CASE: INTERMISSION (May Rounds pa) ===
            console.log("Entering Intermission...");
            
            // 1. Update DB to 'round_ended'
            await updateDoc(roomRef, { status: 'round_ended' });
            
            // 2. Enable Start Button for Countdown
            const startBtn = document.getElementById('btn-start-round');
            if(startBtn) { 
                startBtn.innerText = `▶ START ROUND ${currentR + 1}`; 
                startBtn.disabled = false; 
                startBtn.style.opacity = "1"; 
                startBtn.classList.remove('pulse-btn');
            }
            
            // 3. Trigger Auto-Countdown (Optional)
            // Kung gusto mo automatic agad ang countdown, tawagin ito:
            // window.startIntermissionCountdown(currentR + 1);

        } else {
            // === CASE: FINAL GAME OVER (Tapos na lahat) ===
            console.log("Class Finished.");
            await updateDoc(roomRef, { status: 'finished' });
            
            // Hide Start Button
            const startBtn = document.getElementById('btn-start-round');
            if(startBtn) startBtn.classList.add('hidden');
        }
    }
};


// ==========================================
// 📡 LIVE TELEMETRY SENDER (BULLETPROOF)
// ==========================================

    // Failsafe check
    // 🟢 OPTIMIZED TELEMETRY SENDER (Saves Firebase Quota!)
window.lastSentData = { score: -1, acc: -1 };

window.reportProgress = async function(isFinal = false) {
    if (state.gameMode !== 'classroom' || !currentRoomId) return;
    
    let targetId = window.myDocId || myDocId || (currentUser ? currentUser.uid : myName);
    if (!targetId) return;

    let history = state.gameHistory || [];
    let correctCount = history.filter(h => h && h.status === 'correct').length;
    let totalAttempts = history.length;
    let accuracy = totalAttempts > 0 ? Math.round((correctCount / totalAttempts) * 100) : 100;
    if (totalAttempts === 0 && state.score > 0) accuracy = 100;

    // 🛡️ ANTI-SPAM FILTER: Wag mag-send kung pareho lang ang data, MALIBAN na lang kung final call na.
    if (!isFinal && window.lastSentData.score === state.score && window.lastSentData.acc === accuracy) {
        return; // Skip sending to database!
    }

    // Update Memory
    window.lastSentData.score = state.score;
    window.lastSentData.acc = accuracy;

    try {
        const studentRef = doc(db, "rooms", currentRoomId, "students", targetId);
        
        let errorCounts = { '+': 0, '-': 0, 'x': 0, '÷': 0, 'Alg': 0 };
        let mistakesList = state.mistakes || [];
        mistakesList.forEach(m => { 
            if (!m || !m.q) return; 
            let qStr = m.q.toString();
            if(qStr.includes('x') && qStr.includes('=')) errorCounts['Alg']++;
            else if(qStr.includes('+')) errorCounts['+']++;
            else if(qStr.includes('-')) errorCounts['-']++;
            else if(qStr.includes('x')) errorCounts['x']++;
            else if(qStr.includes('÷')) errorCounts['÷']++;
        });
        
        let weakness = Object.keys(errorCounts).reduce((a, b) => errorCounts[a] > errorCounts[b] ? a : b);
        if (errorCounts[weakness] === 0) weakness = "None";

        await setDoc(studentRef, { 
            uid: targetId, 
            name: myName || "Agent", 
            currentScore: state.score || 0,
            totalScore: state.score || 0, 
            accuracy: accuracy,
            combo: state.combo || 0, 
            roundsPlayed: state.roundsPlayed || 1,
            status: isFinal ? 'finished' : 'playing', 
            inputLocked: state.inputLocked || false,
            lastAnswer: window.inputField ? window.inputField.value : "",
            lastActive: Date.now(), 
            needsHelp: state.helpRequested || false,
            weakestLink: weakness
        }, { merge: true });
        
        console.log(`📡 Beamed Data -> Score: ${state.score}, Acc: ${accuracy}%`);
    } catch(e) { 
        console.error("❌ Telemetry Sync Error:", e); 
    } 
};


// ==========================================
// 🎛️ DASHBOARD TAB CONTROLLER (IRONCLAD V2)
// ==========================================
window.switchDashTab = function(tabName, event) {
    if(window.Sound && event) window.Sound.click(); // Only play sound if clicked, not auto-switched
    
    // 1. NUCLEAR HIDE: Reset and hide ALL tabs
    document.querySelectorAll('.dash-view').forEach(d => {
        d.classList.add('hidden');
        d.style.display = ''; // DONT USE 'none'. Let CSS .hidden handle it!
    });
    
    // 2. Remove active state from all buttons
    document.querySelectorAll('.dash-tabs-container .tab-btn, .dash-tabs .tab-btn').forEach(b => {
        b.classList.remove('active');
    });
    
    // 3. FORCE SHOW ACTIVE TAB
    const selectedView = document.getElementById(`view-${tabName}`);
    if (selectedView) {
        selectedView.classList.remove('hidden');
        
        // Remove ALL inline styles that might be squishing it!
        selectedView.removeAttribute('style'); 
        
        // Apply Ironclad Flexbox rules directly to be safe
        selectedView.style.display = 'flex';
        selectedView.style.flexDirection = 'column';
        selectedView.style.flexGrow = '1';
        selectedView.style.width = '100%';
        selectedView.style.height = '100%';
        selectedView.style.overflow = 'hidden';
    }
    
    // Highlight the clicked button
    if(event && event.target) {
        event.target.classList.add('active');
    } else {
        // If auto-switched (e.g., from JS logic), find the right button and highlight it
        const targetBtn = document.querySelector(`.tab-btn[onclick*="'${tabName}'"]`);
        if(targetBtn) targetBtn.classList.add('active');
    }

    // 4. TRIGGER DATA RENDERERS
    if(tabName === 'grid' && window.updateSpyView) window.updateSpyView();
    if(tabName === 'roster' && window.updateRosterView) window.updateRosterView();
    if(tabName === 'podium' && window.updatePodiumView) window.updatePodiumView();
    if(tabName === 'reports' && window.updateReportView) window.updateReportView();
};

window.exportToCSV = function() {
    let csv = "Agent Name,Score,Accuracy,Status,Last Input\n";
    currentStudentData.forEach(s => { csv += `${s.name},${s.currentScore},${s.accuracy}%,${s.status},${s.lastAnswer || ''}\n`; });
    const blob = new Blob([csv], { type: 'text/csv' }); const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `Class_Report_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
};

window.drawTurretAt = function(cx, cy, color) {
    const ctx = window.ctx; 
    if(!ctx) return;
    
    let time = Date.now();
    // Recoil effect: Uurong ang ship pababa pag tumira
    let recoil = state.shootTimer && (time - state.shootTimer < 100) ? 15 : 0; 

    ctx.save();
    // Ilipat ang drawing point sa cx, cy (Bottom Center ng screen)
    ctx.translate(cx, cy);

    // --- 1. SETUP SKINS ---
    let equip = state.equipped || { turret: 'turret_def', fx: 'fx_blue' };
    let skinID = equip.turret || 'turret_def';
    let fxID = equip.fx || 'fx_blue';
    
    let fxItem = (typeof shopCatalog !== 'undefined') ? shopCatalog.fx.find(f => f.id === fxID) : null;
    let fxColor = fxItem ? fxItem.color : color;
    let fxAura = fxItem ? fxItem.aura : 'none';

    // --- 2. DRAW AURA (Likod ng Ship) ---
    if (window.drawEnemyAura && fxAura !== 'none') {
        // I-adjust ang Y (-150) para nasa gitna ng ship ang aura
        window.drawEnemyAura(ctx, 0, -150, 100, fxAura, time); 
    }

    // --- 3. DRAW SHIP IMAGE ---
    // I-apply ang recoil sa Y axis
    ctx.translate(0, recoil); 

    let imgObj = (assets.ships && assets.ships[skinID]) ? assets.ships[skinID].img : null;

    // Palitan ang pag-draw ng image sa loob ng window.drawTurretAt:

    if (imgObj && imgObj.complete && imgObj.src) {
        // 🟢 FIX: Pinaliit ang size (Dati 360, ngayon 220)
        let width = 220; 
        let height = 220; 
        
        // 🟢 FIX: Ibinaba ang posisyon (Binago ang Y offset)
        ctx.drawImage(imgObj, -width/2, -height + 40, width, height);
    } else {
        // Fallback Geometry
        ctx.fillStyle = fxColor; ctx.fillRect(-8, -80, 16, 80); 
        ctx.fillStyle = "#111"; 
        ctx.beginPath(); ctx.moveTo(-40, 0); ctx.lineTo(0, -90); ctx.lineTo(40, 0); ctx.fill();
        ctx.strokeStyle = fxColor; ctx.lineWidth = 3; ctx.stroke();
    }
    
    // 🟢 FIX: Ibinaba rin ang Muzzle Glow at Pet Holo Position
    ctx.shadowBlur = 20; ctx.shadowColor = fxColor;
    ctx.fillStyle = fxColor;
    ctx.beginPath(); ctx.arc(0, -160, 5, 0, Math.PI*2); ctx.fill(); // Dati -220
    // Pwesto sa taas ng ship
    ctx.beginPath(); ctx.arc(0, -220, 5, 0, Math.PI*2); ctx.fill();

    // --- 5. 🐾 DRAW EQUIPPED PET (HOLOGRAPHIC DRONES) ---
    if (equip.pet) {
        let allPets = [
            ...petCatalog.common, ...petCatalog.rare, 
            ...petCatalog.epic, ...petCatalog.legendary, ...petCatalog.mythic
        ];
        let myPet = allPets.find(p => p.id === equip.pet);
        
        if (myPet) {
            ctx.save();
            
            // 1. Complex Hover & Breathing Animation
            let hoverY = Math.sin(time / 300) * 20; 
            let breath = (Math.sin(time / 150) + 1) / 2; // 0 to 1 value
            
            ctx.translate(140, -180 + hoverY); 
            
            // 2. Dynamic Color base sa Rarity
            let pColor = "rgba(200,255,255,0.8)"; // Common
            if(myPet.rarity === 'Rare') pColor = "#00e5ff";
            if(myPet.rarity === 'Epic') pColor = "#b000ff";
            if(myPet.rarity === 'Legendary') pColor = "#ffd700";
            if(myPet.rarity === 'Mythic') pColor = "#ff0055";

            // 3. Draw The Cyber-Leash (Energy Tether)
            ctx.shadowBlur = 10;
            ctx.shadowColor = pColor;
            ctx.beginPath();
            ctx.moveTo(-140, -hoverY + 50); // Mula sa Ship
            ctx.quadraticCurveTo(-70, 50, 0, 0); // Curve papunta sa pet
            ctx.strokeStyle = pColor;
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 10]); // Energy pulses
            ctx.lineDashOffset = -time / 20; // Umaandar na kuryente!
            ctx.stroke();
            ctx.setLineDash([]); // Reset

            // 4. DRAW THE GEOMETRIC HOLOGRAPHIC PET
            ctx.globalCompositeOperation = 'screen';
            ctx.shadowBlur = 30 + (10 * breath);
            ctx.shadowColor = pColor;
            
            // Iba-ibang hugis base sa Rarity!
            ctx.rotate(time / 1000); // Constant slow rotation
            
            if (myPet.rarity === 'Common') {
                // Spinning Cube
                ctx.strokeStyle = pColor; ctx.lineWidth = 3;
                ctx.strokeRect(-15, -15, 30, 30);
                ctx.rotate(Math.PI / 4);
                ctx.strokeRect(-15, -15, 30, 30);
            } 
            else if (myPet.rarity === 'Rare') {
                // Diamond Core
                ctx.fillStyle = "rgba(0, 229, 255, 0.2)";
                ctx.strokeStyle = pColor; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(0, -25); ctx.lineTo(25, 0); ctx.lineTo(0, 25); ctx.lineTo(-25, 0); ctx.closePath();
                ctx.fill(); ctx.stroke();
                // Inner Eye
                ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(0,0, 5 + (3*breath), 0, Math.PI*2); ctx.fill();
            }
            else if (myPet.rarity === 'Epic') {
                // Pulsing Triangle/Pyramid
                ctx.strokeStyle = pColor; ctx.lineWidth = 4;
                ctx.beginPath(); ctx.moveTo(0, -30); ctx.lineTo(25, 20); ctx.lineTo(-25, 20); ctx.closePath(); ctx.stroke();
                ctx.rotate(Math.PI);
                ctx.beginPath(); ctx.moveTo(0, -30); ctx.lineTo(25, 20); ctx.lineTo(-25, 20); ctx.closePath(); ctx.stroke();
            }
            else if (myPet.rarity === 'Legendary') {
                // Star-Forged Rings
                ctx.strokeStyle = pColor; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI*2); ctx.stroke();
                ctx.rotate(-time / 500); // Counter rotate inner ring
                ctx.beginPath(); ctx.ellipse(0, 0, 35, 10, 0, 0, Math.PI*2); ctx.stroke();
                ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(0,0, 8, 0, Math.PI*2); ctx.fill();
            }
            else if (myPet.rarity === 'Mythic') {
                // Glitch Entity / Dark Core
                ctx.fillStyle = "#000"; // Black hole center
                ctx.beginPath(); ctx.arc(0,0, 20, 0, Math.PI*2); ctx.fill();
                
                // Erratic Rings
                ctx.strokeStyle = pColor; ctx.lineWidth = 4;
                ctx.beginPath(); ctx.arc((Math.random()-0.5)*5, (Math.random()-0.5)*5, 30, 0, Math.PI*1.5); ctx.stroke();
                ctx.strokeStyle = "white"; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.arc(0, 0, 40 + (Math.random()*10), 0, Math.PI*2); ctx.stroke();
            }

            ctx.restore();
        }
    }

    // ==========================================
    // 🔥 OVERDRIVE: DIEGETIC HOLOGRAPHIC INPUT
    // ==========================================
    let playerInputEl = document.getElementById("player-input");
    let typedText = playerInputEl ? playerInputEl.value : "";

    if (typedText.length > 0) {
        ctx.save();
        // Floating above the turret muzzle
        ctx.translate(0, -320); 
        
        // Dynamic Breathing Animation for the Text
        let scalePulse = 1 + (Math.sin(time / 100) * 0.05); 
        ctx.scale(scalePulse, scalePulse);

        // Holographic Backplate (Dark glass behind text)
        ctx.font = "900 45px 'Orbitron'";
        let textWidth = ctx.measureText(typedText).width;
        
        ctx.fillStyle = "rgba(0, 5, 15, 0.8)";
        ctx.beginPath();
        ctx.roundRect(-textWidth/2 - 25, -35, textWidth + 50, 70, 10);
        ctx.fill();
        
        // Cyan Glowing Border
        ctx.strokeStyle = "rgba(0, 229, 255, 0.8)";
        ctx.lineWidth = 2;
        ctx.shadowBlur = 15;
        ctx.shadowColor = "#00e5ff";
        ctx.stroke();

        // The Text Itself (Pure Energy)
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";
        ctx.fillText(typedText, 0, 0);

        // Charging Spark Particles (Glows while you type)
        if (Math.random() > 0.4) {
            let sparkColor = Math.random() > 0.5 ? "#00e5ff" : "#ffffff";
            createParticles(cx + (Math.random()-0.5)*80, cy - 320, sparkColor, 1);
        }

        ctx.restore();
    }

    ctx.restore(); // Ito yung pinaka-orihinal na ctx.restore() sa dulo ng function mo
};



window.fixGameResolution = function() { 
    if (!window.canvas) window.canvas = document.getElementById("gameCanvas");
    
    if(window.canvas) {
        // 🟢 FIX: Force InnerWidth/Height para hindi maging 0x0 kapag galing sa hidden menu!
        window.canvas.width = window.innerWidth; 
        window.canvas.height = window.innerHeight; 
        
        // Re-generate background elements to fit new size
        if(typeof state !== 'undefined' && state.isPlaying) { 
            if(window.generateCity) generateCity(); 
            if(window.initStars) initStars(); 
        }
    }
    
    // Fix Background Canvas as well
    const bgCanvas = document.getElementById("bgCanvas"); 
    if(bgCanvas) { 
        bgCanvas.width = window.innerWidth; 
        bgCanvas.height = window.innerHeight; 
    }
};

// 🚨 Add Listener specifically for zoom events
window.addEventListener('resize', () => {
    window.fixGameResolution();
    // Optional: Reposition Boss if resize happens during battle
    if(state.bossActive && state.bossData) {
        state.bossData.x = window.canvas.width / 2; // Keep boss centered
    }
});

window.getTurretX = function(index, total) { return (window.canvas.width / total) * index + (window.canvas.width / total / 2); };
window.showClassroomSetup = function() { if(window.Sound) window.Sound.click(); document.getElementById("start-modal").classList.add("hidden"); document.getElementById("classroom-setup-modal").classList.remove("hidden"); };
window.closeClassroomSetup = function() { if(window.Sound) window.Sound.click(); document.getElementById("classroom-setup-modal").classList.add("hidden"); document.getElementById("start-modal").classList.remove("hidden"); };
window.showLeaderboard = async function() {
    if(window.Sound) window.Sound.click(); document.getElementById("start-modal").classList.add("hidden"); document.getElementById("leaderboard-modal").classList.remove("hidden");
    const list = document.getElementById("leaderboard-list-modal"); if(list) list.innerHTML = "Loading Data...";
    try {
        if (!db) { throw new Error("Database connection failed"); }
        const q = query(collection(db, "scores"), orderBy("score", "desc"), limit(10));
        const snap = await getDocs(q); let html = ""; let rank = 1;
        snap.forEach(d => { let data = d.data(); html += `<div class="lb-row" style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid #444;"><span>#${rank} ${data.name}</span><span style="color:gold">${data.score}</span></div>`; rank++; });
        if(list) list.innerHTML = html || "No scores yet.";
    } catch(e) { console.error(e); if(list) list.innerHTML = "Error loading data."; }
};

window.viewMistakes = function() {
    if(window.Sound) window.Sound.click();
    
    const logContainer = document.getElementById("mistakes-log");
    const btn = document.getElementById("view-mistakes-btn");
    
    if (!logContainer || !btn) return;

    // TOGGLE LOGIC
    if (logContainer.classList.contains("hidden")) {
        // --- SHOW MISTAKES ---
        logContainer.classList.remove("hidden");
        btn.innerText = "🔼 HIDE MISTAKES";
        
        logContainer.innerHTML = ""; // Clear old content
        
        const validMistakes = state.mistakes || [];

        if (validMistakes.length === 0) {
            logContainer.innerHTML = `
                <div class="log-item" style="text-align:center; color:#888; padding:20px; border:1px dashed #444; font-size:14px;">
                    NO TACTICAL ERRORS RECORDED.<br>
                    <span style="font-size:12px; color:#555;">PERFECT RUN AGENT.</span>
                </div>`;
        } else {
            validMistakes.forEach((m, index) => {
                let color = m.type === 'missed' ? '#ff0055' : '#ffd700'; 
                let label = m.type === 'missed' ? 'MISSED TARGET' : 'CALCULATION ERROR';
                
                let qDisplay = (m.q === "UNKNOWN" || !m.q) ? "TARGET LOST" : m.q;
                let correctDisplay = (m.a === "UNKNOWN" || !m.a) ? "?" : m.a;
                let userIn = m.wrong || '-';
                
                // ✅ CAPSTONE FEATURE: AI EXPLANATION BUTTON
                // (Siguraduhing na-paste mo rin ang getExplanation helper function sa file mo)
                let explanation = (window.getExplanation) ? window.getExplanation(qDisplay.toString(), correctDisplay) : "Review math rules.";
                let uniqueId = `sol-${index}`;

                let html = `
                    <div class="log-item" style="border-left: 4px solid ${color}; background: rgba(0,0,0,0.8); margin-bottom: 8px; padding: 12px; border-radius: 0 4px 4px 0; text-align: left; border-bottom: 1px solid #333;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="color:white; font-size:20px; font-family:'Orbitron'; text-shadow: 0 0 5px ${color};">${qDisplay}</div>
                                <div style="font-size:12px; color:#aaa; margin-top:4px;">CORRECT: <span style="color:#00ff41; font-weight:bold;">${correctDisplay}</span></div>
                            </div>
                            <div style="text-align:right;">
                                <div style="color:${color}; font-weight:bold; font-size:10px; letter-spacing:1px; margin-bottom:4px;">${label}</div>
                                <div style="color:white; font-size:14px; font-family:'Courier New'; margin-bottom: 5px;">INPUT: <span style="border-bottom:1px solid #fff;">${userIn}</span></div>
                                
                                <button class="btn text-only" style="padding:2px 8px; font-size:10px; border:1px solid #00e5ff; color:#00e5ff;" onclick="document.getElementById('${uniqueId}').classList.toggle('hidden')">
                                    💡 WHY?
                                </button>
                            </div>
                        </div>
                        <div id="${uniqueId}" class="hidden" style="margin-top:10px; padding:10px; background:rgba(0, 229, 255, 0.1); border-left:2px solid #00e5ff; color:#ccc; font-size:12px; font-family:'Courier New'; white-space: pre-wrap;">${explanation}</div>
                    </div>`;
                logContainer.innerHTML += html;
            });
        }
    } else {
        // --- HIDE MISTAKES ---
        logContainer.classList.add("hidden");
        btn.innerText = "📂 REVIEW MISTAKES";
    }
};

window.addEventListener('resize', fixGameResolution);
window.addEventListener('DOMContentLoaded', fixGameResolution);
setTimeout(fixGameResolution, 100); 

// ==========================================
// 🔒 SYSTEM JAMMER (CLASSROOM PENALTY)
// ==========================================
window.triggerInputLock = function() {
    if (state.inputLocked) return; // Already locked

    // Safety: Clear any existing timer to prevent stacking
    if (state.lockTimer) {
        clearInterval(state.lockTimer);
        state.lockTimer = null;
    }

    state.inputLocked = true;
    const input = document.getElementById("player-input");
    if (!input) return;

    // 🔴 ABSOLUTE LOCKDOWN: Patayin ang HTML element para walang daya!
    input.disabled = true; 
    input.classList.add("input-jammed");
    input.blur(); // Remove focus immediately
    
    if(window.Sound) window.Sound.error();

    let timeLeft = 3; // 3 Seconds Penalty
    input.value = `LOCKED (${timeLeft})`;

    // Countdown Timer
    state.lockTimer = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            input.value = `LOCKED (${timeLeft})`;
        } else {
            // 🟢 UNLOCK & REBOOT
            clearInterval(state.lockTimer); 
            state.lockTimer = null;         
            
            state.inputLocked = false;
            input.disabled = false; // Payagan na ulit mag-type
            input.classList.remove("input-jammed");
            input.value = "";
            input.focus(); // Ibalik ang cursor sa bata
            
            input.placeholder = "SYSTEM REBOOTED";
            setTimeout(() => input.placeholder = "AWAITING INPUT...", 1000);
        }
    }, 1000);
};

// Siguraduhin ding globally accessible ito:
function triggerInputLock() { window.triggerInputLock(); }




// ==========================================
// 🚀 MASTER JOIN ROOM LOGIC (CLASSROOM & MULTIPLAYER)
// ==========================================
window.joinRoom = async function() {
    const codeInput = document.getElementById("join-code-input");
    const code = codeInput.value.toUpperCase().trim();
    
    // 1. Initial Validation
    if(code.length < 4) {
        if (window.toggleCurtain) window.toggleCurtain(false); // Cancel curtain if invalid
        return alert("Invalid Room Code");
    }
    
    if(!window.validateName()) {
        if (window.toggleCurtain) window.toggleCurtain(false); // Cancel curtain if no name
        return; 
    }

    // 2. Trigger Cyber Curtain (Visual Feedback)
    const curtain = document.getElementById("class-curtain");
    if (curtain && curtain.classList.contains("hidden")) {
        window.toggleCurtain(true, "ACCESSING MAINFRAME", "SEARCHING FREQUENCY...", false);
    }

    try {
        const roomRef = doc(db, "rooms", code);
        const roomSnap = await getDoc(roomRef);
        
        if(!roomSnap.exists()) {
            // 🛑 ERROR: Patayin ang Curtain at Ibalik ang Menu
            setTimeout(() => {
                if (window.toggleCurtain) window.toggleCurtain(false);
                alert("Room not found! Check the code.");
                document.getElementById("start-modal").classList.remove("hidden");
            }, 500);
            return;
        }
        
        // --- SUCCESS: Hide Menus ---
        document.getElementById("start-modal").classList.add("hidden");
        document.getElementById("mp-menu-modal").classList.add("hidden");
        document.getElementById("class-selection-modal").classList.add("hidden");
        document.getElementById("profile-section").classList.add("hidden");
        
        const roomData = roomSnap.data();
        
        // --- CLASSROOM MODE LOGIC ---
        if (roomData.mode === 'classroom') {
            state.gameMode = 'classroom';
            currentRoomId = code;
            isHost = false;
            
            // Generate or fetch Student ID
            window.myDocId = currentUser ? currentUser.uid : myName;
            const studentRef = doc(db, "rooms", code, "students", window.myDocId);
            
            // Register Student to Class Database
            await setDoc(studentRef, {
                uid: window.myDocId, 
                name: myName, 
                status: 'online', 
                currentScore: 0, 
                totalScore: 0, 
                accuracy: 100, 
                joinedAt: new Date()
            }, { merge: true });

            // Save Session for Auto-Rejoin
            saveSession('student', code, myName, myDocId);

            // Sync Teacher's Difficulty and Operations
            if(roomData.config) {
                state.difficulty = roomData.config.difficulty;
                state.classroomTopic = roomData.config.topic; 
                if (roomData.config.ops) state.selectedOps = roomData.config.ops;
            }
            
            // Proceed to Classroom Lobby UI
            enterClassroomLobby(code, roomData.roomName);
            
        } 
        // --- STANDARD MULTIPLAYER LOGIC (VS / TEAM) ---
        else {
            state.gameMode = roomData.mode || 'party';
            isHost = false;
            
            if (roomData.settings) {
                state.selectedOps = roomData.settings.ops;
                state.difficulty = roomData.settings.diff;
            }
            
            // Add player to the room list
            let newPlayers = roomData.players || [];
            if (!newPlayers.some(p => p.name === myName)) {
                newPlayers.push({name: myName});
                await updateDoc(roomRef, { players: newPlayers });
            }
            
            myPlayerIndex = newPlayers.length - 1; 
            currentRoomId = code; 
            
            // Proceed to standard Lobby UI
            enterLobbyUI(code);
            if(socket) socket.emit('join_room', { room: code, name: myName });
        }
        
    } catch(e) { 
        console.error("Room Join Error:", e); 
        if (window.toggleCurtain) window.toggleCurtain(false);
        alert("Error joining room: " + e.message); 
    }
};

window.showClassroomSetup = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("start-modal").classList.add("hidden");
    document.getElementById("classroom-setup-modal").classList.remove("hidden");
};

window.closeClassroomSetup = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("classroom-setup-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.remove("hidden");
};

// --- 🧠 RESTORED AI LOGIC (Paste after Part 1) ---

window.generateSmartTip = function(q, userAns = null) {
    if (!q) return "Analyze the pattern.";
    let cleanQ = q.toString().replace(/\s+/g, '');
    let parts = q.match(/(-?\d+)\s*([+\-x÷])\s*(-?\d+)/);
    
    // Algebra Tips
    if (cleanQ.includes('=') || (cleanQ.includes('x') && /[a-z]/i.test(cleanQ) && !parts)) {
        if (cleanQ.includes('+')) return "LOGIC: The Plus is a lock. Use MINUS to unlock X.";
        if (cleanQ.includes('-')) return "LOGIC: The Minus is a gap. Fill it with PLUS to fix X.";
        if (/^\d+x/.test(cleanQ)) return "LOGIC: X is stuck in a group. DIVIDE to break it free.";
        if (cleanQ.includes('/')) return "LOGIC: X is broken. MULTIPLY to make it whole.";
        return "TACTIC: Isolate the unknown. Do the reverse operation.";
    }
    
    // Arithmetic Tips
    if (!parts) return "Focus on the numbers.";
    let n1 = parseInt(parts[1]); let op = parts[2]; let n2 = parseInt(parts[3]);
    let abs1 = Math.abs(n1); let abs2 = Math.abs(n2);

    if (userAns !== null && userAns !== "") {
        let uAns = parseInt(userAns);
        let correct;
        if(op==='+') correct=n1+n2; else if(op==='-') correct=n1-n2; else if(op==='x') correct=n1*n2; else correct=n1/n2;
        
        if (uAns === correct) return "EXCELLENT: Execution perfect.";
        if (op === '+' && uAns === (n1 - n2)) return "DIAGNOSIS: You Subtracted. Look at the Cross (+).";
        if (op === '-' && uAns === (n1 + n2)) return "DIAGNOSIS: You Added. Look at the Dash (-).";
    }
    
    // Pro Strategies
    if (op === '+') {
        if (abs1 === 9 || abs2 === 9) return "PATTERN: 9 is greedy. It steals 1 to become 10.";
    }
    if (op === 'x') {
        if (abs1 === 5 || abs2 === 5) return "PATTERN: Cut the even number in half, then add a Zero.";
        if (abs1 === 11 || abs2 === 11) return "PATTERN: Split the digits, put the SUM in the middle.";
    }
    return "TACTIC: Visualize the groups. You control the numbers.";
};




// --- 🎮 CONTROLS & LEADERBOARD RESTORATION (Paste after Part 2) ---

window.showLeaderboard = async function() {
    if(window.Sound) window.Sound.click(); 
    document.getElementById("start-modal").classList.add("hidden"); 
    document.getElementById("leaderboard-modal").classList.remove("hidden");
    
    const list = document.getElementById("leaderboard-list-modal"); 
    if(list) list.innerHTML = "Loading Data...";
    
    try {
        if (!db) throw new Error("Database offline"); 
        const q = query(collection(db, "scores"), orderBy("score", "desc"), limit(10));
        const snap = await getDocs(q); 
        let html = ""; let rank = 1;
        snap.forEach(d => { 
            let data = d.data(); 
            html += `<div class="lb-row" style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid #444;"><span>#${rank} ${data.name}</span><span style="color:gold">${data.score}</span></div>`; 
            rank++; 
        });
        if(list) list.innerHTML = html || "No scores yet.";
    } catch(e) { if(list) list.innerHTML = "Error loading data."; }
};

// Numpad Functions
window.pressKey = function(key) { 
    if(!state.isPlaying || state.isPaused) return; 
    const input = document.getElementById("player-input"); 
    if(input) { input.value += key; if(window.Sound) window.Sound.click(); } 
};
window.pressClear = function() { 
    const input = document.getElementById("player-input"); 
    if(input) { input.value = ""; if(window.Sound) window.Sound.error(); } 
};
window.pressEnter = function() { 
    const input = document.getElementById("player-input"); 
    if(input && state.isPlaying) { fireLaser(input.value); input.value = ""; } 
};


window.openClassSelection = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("start-modal").classList.add("hidden");
    document.getElementById("class-selection-modal").classList.remove("hidden");
    
    document.getElementById("role-buttons").classList.remove("hidden");
    document.getElementById("student-class-input-section").classList.add("hidden");
};

window.closeClassSelection = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("class-selection-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.remove("hidden");
};

window.selectTeacherRole = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("class-selection-modal").classList.add("hidden");
    window.showClassroomSetup(); 
};

window.selectStudentRole = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("role-buttons").classList.add("hidden");
    document.getElementById("student-class-input-section").classList.remove("hidden");
    document.getElementById("class-code-direct").focus();
};

window.joinClassDirect = function() {
    const directInput = document.getElementById("class-code-direct").value.toUpperCase().trim();
    if (directInput.length < 4) {
        alert("Invalid Class Code");
        return;
    }
    const mainJoinInput = document.getElementById("join-code-input");
    if(mainJoinInput) {
        mainJoinInput.value = directInput;
        document.getElementById("class-selection-modal").classList.add("hidden");
        window.joinRoom(); 
    }
};

window.showClassroomSetup = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("start-modal").classList.add("hidden");
    document.getElementById("classroom-setup-modal").classList.remove("hidden");
};

window.closeClassroomSetup = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("classroom-setup-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.remove("hidden");
};



// --- 🛠️ STEPPER HELPER (For Time Config) ---
window.adjustTime = function(delta) {
    const display = document.getElementById('time-display');
    let current = parseInt(display.getAttribute('data-value'));
    current += delta;
    if (current < 1) current = 1;
    if (current > 60) current = 60;
    
    display.setAttribute('data-value', current);
    display.innerText = (current < 10 ? "0" : "") + current + " : 00";
    if(window.Sound) window.Sound.click();
};

window.adjustRounds = function(delta) {
    const display = document.getElementById('rounds-display');
    let current = parseInt(display.getAttribute('data-value'));
    current += delta;
    if (current < 1) current = 1;
    if (current > 10) current = 10; // Max 10 rounds
    
    display.setAttribute('data-value', current);
    display.innerText = current;
    if(window.Sound) window.Sound.click();
};

// --- 🎛️ UI TOGGLE LOGIC ---
window.toggleSubOps = function() {
    const panel = document.getElementById('sub-ops-panel');
    const checkboxes = panel.querySelectorAll('input[type="checkbox"]');
    const selectedTopic = document.querySelector('input[name="topic-select"]:checked').value;

    if (selectedTopic === 'mixed') {
        // If Mixed: Select ALL, Hide Panel (or Disable it)
        panel.classList.add('hidden'); // Or remove 'hidden' if you want them to see what's included
        checkboxes.forEach(cb => cb.checked = true);
    } else {
        // If Algebra or Integers: Show Panel so they can customize
        panel.classList.remove('hidden');
        // Optional: Reset to default checked state
    }
    
    if(window.Sound) window.Sound.click();
};


// ==========================================
// ⌨️ STRICT KEYBOARD CONTROLLER (FIXED FOR MENUS)
// ==========================================
document.addEventListener("keydown", function(event) {
    if (!state.isPlaying || state.isPaused || state.isGlobalFreeze) {
        // 🟢 FIX: Kung hindi tayo naglalaro (nasa menu tayo), PAYAGAN ANG LAHAT NG TYPING!
        return; 
    }
    
    if (state.inputLocked) {
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
    const activeId = document.activeElement ? document.activeElement.id : "";
    const input = document.getElementById("player-input");

    // --- A. HOTKEYS (HINDI MAGTA-TYPE SA INPUT BOX) ---
    if (event.code === "Space") {
        event.preventDefault(); // Pinipigilan nitong mag-type ng "space"
        if (window.activateEMP) window.activateEMP();
        return;
    }

    if (event.key === "Shift") {
        event.preventDefault(); 
        if (window.activateSlowMo) window.activateSlowMo();
        return;
    }

    // --- B. TYPING FILTER & EXECUTION ---
    if (activeTag === "input" || activeTag === "textarea") {
        if (activeId === "player-input") {
            if (event.key === "Enter") {
                event.preventDefault();
                if (input.value !== "") {
                    fireLaser(input.value);
                    input.value = "";
                }
            } else {
                // 🛡️ THE LETTER FILTER: Harangin ang lahat ng hindi numero o math signs (Sa Laban Lang!)
                const allowedKeys = ['0','1','2','3','4','5','6','7','8','9','-','Backspace','Delete','ArrowLeft','ArrowRight'];
                if (event.key.length === 1 && !allowedKeys.includes(event.key)) {
                    event.preventDefault(); 
                }
            }
        }
        return; // 🟢 FIX: Kapag nasa loob ng ANY input box, wag patakbuhin ang Auto-Focus sa baba!
    }

    // --- C. AUTO-FOCUS TYPING (Para sa Combat Lang) ---
    const allowedKeys = ['0','1','2','3','4','5','6','7','8','9','-','Backspace','Delete'];
    if (allowedKeys.includes(event.key)) {
        if (input && document.activeElement !== input) {
            input.focus();
        }
    }
});



// --- 🧠 SMART TUTOR LOGIC (Feature #3) ---
window.getExplanation = function(q, a) {
    // Linisin ang question string
    let cleanQ = q.replace(/\s+/g, '');
    
    // ALGEBRA (e.g., 3x = 12)
    if (cleanQ.includes('x') || cleanQ.includes('=')) {
        if (cleanQ.match(/^\d+x=\d+$/)) { // 3x=12
            let parts = cleanQ.split('x=');
            return `Step 1: Isolate x.\nStep 2: Divide ${parts[1]} by ${parts[0]}.\nAnswer: ${a}`;
        }
        if (cleanQ.includes('+')) { // x+5=10
            let parts = cleanQ.split('=');
            let num = parts[0].replace('x+', '');
            return `Step 1: Move +${num} to the other side (becomes -${num}).\nStep 2: ${parts[1]} - ${num} = ${a}.`;
        }
        if (cleanQ.includes('-')) { // x-5=10
            let parts = cleanQ.split('=');
            let num = parts[0].replace('x-', '');
            return `Step 1: Move -${num} to the other side (becomes +${num}).\nStep 2: ${parts[1]} + ${num} = ${a}.`;
        }
        return "Algebra Rule: Perform the reverse operation to isolate X.";
    }

    // ARITHMETIC (e.g., 10 + 5)
    if (cleanQ.includes('+')) return "Addition: Combine the numbers together.";
    if (cleanQ.includes('-')) {
        let parts = cleanQ.split('-');
        if(parseInt(parts[0]) < parseInt(parts[1])) return "Negatives: The second number is bigger. Subtract normally, then keep the Negative sign.";
        return "Subtraction: Take away the second number from the first.";
    }
    if (cleanQ.includes('x') || cleanQ.includes('*')) return "Multiplication: Add the number to itself repeatedly.";
    if (cleanQ.includes('÷') || cleanQ.includes('/')) return "Division: How many times does the second number fit into the first?";

    return "Logic: Analyze the operation and calculate.";
};

// ... existing event listeners ...
window.addEventListener('load', initRain);

// ✅ NEW: Attempt to restore session on page load
window.addEventListener('DOMContentLoaded', () => {
    fixGameResolution();
    restoreSession(); // Run Phase 1 Stability Check
});


window.toggleHelp = function() {
    // 🚨 3-SECOND COOLDOWN (Prevents Database Spam)
    if (window.isHelpOnCooldown) return;
    
    state.helpRequested = !state.helpRequested;
    const btn = document.getElementById('btn-help');
    
    if (state.helpRequested) {
        btn.style.background = "#ffd700";
        btn.style.color = "black";
        btn.style.boxShadow = "0 0 20px #ffd700";
        if(window.Sound) window.Sound.click();
    } else {
        btn.style.background = "rgba(255,255,255,0.05)";
        btn.style.color = "#ffd700";
        btn.style.boxShadow = "none";
    }
    
    reportProgress(false);

    // Apply Cooldown
    window.isHelpOnCooldown = true;
    setTimeout(() => { window.isHelpOnCooldown = false; }, 3000);
};
// ==========================================
// 🧠 CLASS DIAGNOSTICS & FINAL REPORT (REDESIGNED)
// ==========================================
window.generateClassDiagnostics = function() {
    console.log("Generating Command Center Report...");
    
    // 1. UPDATE HEADER
    document.getElementById("final-room-code").innerText = currentRoomId || "UNKNOWN";
    document.getElementById("final-student-count").innerText = currentStudentData.length;

    // 2. CALCULATE CLASS STATS
    let totalScore = 0;
    let totalAcc = 0;
    let tally = { '+': 0, '-': 0, 'x': 0, '÷': 0, 'Alg': 0 };
    
    currentStudentData.forEach(s => {
        totalScore += (s.totalScore || 0);
        totalAcc += (s.accuracy || 100);
        
        // Weakness Tally
        let w = s.weakestLink || 'None';
        if (tally[w] !== undefined) tally[w]++;
    });

    let avgScore = currentStudentData.length ? Math.floor(totalScore / currentStudentData.length) : 0;
    let avgAcc = currentStudentData.length ? Math.floor(totalAcc / currentStudentData.length) : 0;

    document.getElementById("final-avg-score").innerText = avgScore;
    document.getElementById("final-avg-acc").innerText = avgAcc + "%";

    // 3. GENERATE PODIUM (Top 3)
    const podiumContainer = document.getElementById('winners-podium');
    podiumContainer.innerHTML = "";
    
    // Ensure sorted by Score
    const winners = [...currentStudentData].sort((a, b) => b.totalScore - a.totalScore).slice(0, 3);
    const ranks = ['rank-1', 'rank-2', 'rank-3'];
    const emojis = ['👑', '🥈', '🥉'];
    
    // Reorder for visual podium (2nd - 1st - 3rd)
    const displayOrder = [1, 0, 2]; 

    displayOrder.forEach(idx => {
        if(winners[idx]) {
            let s = winners[idx];
            let rClass = ranks[idx];
            let emoji = emojis[idx];
            
            let html = `
                <div class="podium-column ${rClass}">
                    <div class="podium-avatar">${emoji}</div>
                    <div class="podium-bar"><span class="rank-num">${idx + 1}</span></div>
                    <div class="winner-name-tag">${s.name}</div>
                    <div style="color:#ffd700; font-weight:bold; font-size:14px;">${s.totalScore}</div>
                </div>
            `;
            podiumContainer.innerHTML += html;
        }
    });

    // 4. GENERATE HEATMAP (Visual Bars)
    const weaknessEl = document.getElementById('class-weakness-report');
    weaknessEl.innerHTML = "";
    
    // Find hardest topic
    let maxWeaknessVal = 0;
    let hardestTopic = "NONE";
    
    const labels = { '+': 'ADD', '-': 'SUB', 'x': 'MUL', '÷': 'DIV', 'Alg': 'ALG' };
    
    Object.keys(tally).forEach(key => {
        if (tally[key] > maxWeaknessVal) {
            maxWeaknessVal = tally[key];
            hardestTopic = labels[key];
        }
    });
    
    document.getElementById("final-hardest-topic").innerText = hardestTopic;

    // Draw Bars
    Object.keys(labels).forEach(key => {
        let count = tally[key];
        let height = (currentStudentData.length > 0) ? (count / currentStudentData.length) * 100 : 0;
        let color = (labels[key] === hardestTopic && count > 0) ? '#ff0055' : '#00e5ff';
        
        let barHtml = `
            <div style="flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; height:100%;">
                <div style="font-size:10px; color:#fff; margin-bottom:2px;">${count}</div>
                <div style="width:100%; height:${Math.max(5, height)}%; background:${color}; border-radius:4px 4px 0 0; opacity:0.8;"></div>
                <div style="font-size:10px; color:#888; margin-top:5px; font-family:'Rajdhani';">${labels[key]}</div>
            </div>
        `;
        weaknessEl.innerHTML += barHtml;
    });

    // 5. STRUGGLING STUDENTS LIST
    const listEl = document.getElementById('struggling-students-list');
    const struggling = currentStudentData.filter(s => s.accuracy < 60);

    if (struggling.length === 0) {
        listEl.innerHTML = `<div style="text-align:center; padding:10px; color:#00ff41; border:1px dashed #00ff41;">✅ ALL AGENTS PERFORMING OPTIMALLY</div>`;
    } else {
        listEl.innerHTML = "";
        struggling.forEach(s => {
            listEl.innerHTML += `
                <div style="border-bottom:1px solid #333; padding:5px 0; display:flex; justify-content:space-between;">
                    <span style="color:#ff5555;">⚠️ ${s.name}</span>
                    <span style="color:#aaa;">Acc: ${s.accuracy}% | Weakness: ${s.weakestLink}</span>
                </div>
            `;
        });
    }
};

window.initBossShield = function(boss) {
    let n1 = Math.floor(Math.random() * 10) + 1; 
    let n2 = Math.floor(Math.random() * 10) + 1;
    boss.shield = { 
        active: true, 
        hp: 1, 
        q: `${n1} + ${n2}`, 
        a: n1 + n2, 
        maxRadius: 180 
    };
    state.floatingTexts.push({ x: boss.x, y: boss.y + 100, text: "SHIELD GENERATED!", color: "#00f3ff", life: 2.0 });
};

// --- BOSS SHIELD RENDERER ---
window.drawBossShield = function(ctx, boss, time) {
    if (!boss.shield || !boss.shield.active) return;
    
    ctx.save();
    // Shield Glow Effect
    ctx.globalCompositeOperation = 'screen'; 
    ctx.shadowBlur = 30;
    ctx.shadowColor = "cyan";

    // Layer 1: Outer Barrier (Pulse)
    let pulse = Math.sin(time / 200) * 5;
    ctx.beginPath();
    ctx.arc(0, 0, 200 + pulse, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0, 255, 255, 0.6)";
    ctx.lineWidth = 3;
    ctx.stroke();

    // Layer 2: Rotating Hexagon Field
    ctx.rotate(time / 1000);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        let angle = (i * Math.PI * 2) / 6;
        let r = 190;
        ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(0, 200, 255, 0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Shield Text Box
    ctx.globalCompositeOperation = 'source-over'; // Reset blend mode for text
    ctx.rotate(-time / 1000); // Counter-rotate to keep text straight
    
    // Background for text
    ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    ctx.beginPath(); ctx.arc(0, -100, 40, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = "cyan"; ctx.lineWidth = 2; ctx.stroke();

    // Text
    ctx.fillStyle = "#fff"; 
    ctx.font = "900 24px 'Orbitron'"; 
    ctx.textAlign = "center"; 
    ctx.textBaseline = "middle"; 
    ctx.fillText(boss.shield.q, 0, -100); 
    
    ctx.font = "bold 10px 'Rajdhani'"; 
    ctx.fillStyle = "#00ff41"; 
    ctx.fillText("SHIELD HP: " + boss.shield.hp, 0, -80);
    
    ctx.restore();
};

function drawJaggedLine(ctx, x1, y1, x2, y2, displace) {
    if (displace < 15) {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        return;
    }
    let midX = (x1 + x2) / 2;
    let midY = (y1 + y2) / 2;
    midX += (Math.random() - 0.5) * displace;
    midY += (Math.random() - 0.5) * displace;
    drawJaggedLine(ctx, x1, y1, midX, midY, displace / 2);
    drawJaggedLine(ctx, midX, midY, x2, y2, displace / 2);
}

// --- BOSS MECHANICS (Aura & Attack) ---
window.handleBossMechanics = function(ctx, boss, time) {
    if (!boss || !boss.isBoss) return;
    
    // --- 1. DARK MATTER AURA (Rotating Dark Clouds) ---
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    let grad = ctx.createRadialGradient(0, 0, 100, 0, 0, 300);
    grad.addColorStop(0, "rgba(50, 0, 0, 0)");
    grad.addColorStop(1, "rgba(50, 0, 0, 0.5)");
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, 300, 0, Math.PI*2); ctx.fill();
    ctx.restore();

    // --- 2. PERSISTENT LIGHTNING (Makatotohanan Effect) ---
    if (Math.random() > 0.5) { // 50% chance per frame to flicker
        ctx.save();
        ctx.strokeStyle = `rgba(255, 255, 0, ${Math.random()})`; // Yellow/White Lightning
        ctx.lineWidth = 2;
        ctx.shadowBlur = 15; ctx.shadowColor = "white";
        
        // Random Lightning Arcs from Boss Body
        let numBolts = Math.floor(Math.random() * 3) + 1;
        for(let i=0; i<numBolts; i++) {
            let angle = Math.random() * Math.PI * 2;
            let startX = Math.cos(angle) * 100;
            let startY = Math.sin(angle) * 100;
            let endX = Math.cos(angle) * 280;
            let endY = Math.sin(angle) * 280;
            drawJaggedLine(ctx, startX, startY, endX, endY, 80);
        }
        ctx.restore();
    }

    // --- 3. ATTACK CYCLE ---
    let cycle = time % 5000;
    
    // CHARGING (Red Laser Sight)
    if (cycle > 3000 && cycle < 4500) { 
        state.bossAttackState.charging = true; 
        state.bossAttackState.firing = false;
        
        ctx.save();
        ctx.beginPath(); 
        ctx.moveTo(0, 150); ctx.lineTo(0, window.canvas.height); 
        ctx.strokeStyle = "rgba(255, 0, 0, 0.5)"; ctx.lineWidth = 1; ctx.setLineDash([50, 50]); 
        ctx.stroke(); // Laser Sight
        
        // Gathering Energy Ball
        let orbSize = Math.random() * 30 + 20;
        ctx.fillStyle = "rgba(255, 50, 0, 0.8)";
        ctx.shadowBlur = 50; ctx.shadowColor = "red";
        ctx.beginPath(); ctx.arc(0, 150, orbSize, 0, Math.PI*2); ctx.fill();
        ctx.restore();

        if (Math.random() > 0.95) {
            state.floatingTexts.push({ x: boss.x + (Math.random()-0.5)*100, y: boss.y + 200, text: "⚠️ LOCKED", color: "#ff0055", life: 0.4 });
        }
    } 
    // FIRING (Hyper Beam)
    else if (cycle >= 4500 && cycle < 4600) { 
        if (!state.bossAttackState.firing) {
            state.bossAttackState.firing = true; 
            if(window.Sound) window.Sound.nuke(); 
            state.shake = 30; 
            if (state.gameMode !== 'classroom') {
                state.health -= 5; updateHUD(); if(state.health <= 0) gameOver(); 
            }
        }
        
        ctx.save();
        ctx.shadowBlur = 80; ctx.shadowColor = "white";
        ctx.beginPath(); ctx.moveTo(0, 150); ctx.lineTo(0, window.canvas.height);
        ctx.lineWidth = 80; ctx.strokeStyle = "rgba(255, 0, 0, 0.8)"; ctx.stroke(); 
        ctx.lineWidth = 40; ctx.strokeStyle = "white"; ctx.stroke(); 
    } 
    else { 
        state.bossAttackState.charging = false; 
        state.bossAttackState.firing = false; 
    }
};

window.showDamage = function(x, y) { 
    let dmg = Math.floor(Math.random() * 100) + 150; 
    state.floatingTexts.push({ 
        x: x, y: y, 
        text: `-${dmg}`, 
        color: "#fff", 
        life: 1.0, 
        isDamage: true 
    }); 
};

// ==========================================
// 🛸 GALACTIC WAR INTRO LOGIC (GOD LEVEL)
// ==========================================

window.startSystem = function() {
    const bootScreen = document.getElementById('boot-overlay');
    const initBtn = document.getElementById('btn-master-start');
    
    // 1. I-lock ang button para hindi ma-spam click
    if (initBtn) initBtn.disabled = true;

    // 2. I-trigger ang Blue Flash Animation (Parang Nabaril)
    if (bootScreen) bootScreen.classList.add('system-firing');

    // 3. UNLOCK AUDIO & PLAY SOUND EFFECTS
    if(window.Sound) {
        window.Sound.init(); 
        if (window.Sound.ctx && window.Sound.ctx.state === 'suspended') window.Sound.ctx.resume();
        
        // Massive Laser & Explosion Sound
        window.Sound.laser();
        setTimeout(() => window.Sound.nuke(), 200);

        // 4. 🗣️ THE AI VOICE GREETING (For Panelists)
        console.log("Audio Unlocked. Greeting Panelists...");
        
        // Dynamic Greeting (Good Morning / Good Afternoon)
        let hours = new Date().getHours();
        let greeting = hours < 12 ? "Good morning" : "Good afternoon";
        
        let voiceMessage = `Voice Authorization Accepted. ${greeting}, dear Panelists. Welcome to Jess-Math: Elite Defense. System Online.`;
        window.Sound.speak(voiceMessage);
    }

    // 5. THE FADE OUT TRANSITION
    setTimeout(() => {
        if (bootScreen) {
            bootScreen.style.opacity = '0';
            bootScreen.style.filter = 'blur(20px)'; // Parang nahihilo effect
            
            setTimeout(() => {
                bootScreen.style.display = 'none'; // Tuluyan nang itago
                
                // 6. Play Cinematic BGM & Start Intro
                if(window.Sound) window.Sound.playBGM('intro'); 
                runCinematicSequence();
                
            }, 1000); // Hintayin matapos ang fade out
        }
    }, 1500); // Delay bago mag-fade para makita ang flash
};

// 2. The Animation Sequence
function runCinematicSequence() {
    const intro = document.getElementById('cinematic-intro');
    const warContainer = document.getElementById('war-container');

    if (!intro || !warContainer) return;

    // Start Chaos Loop
    const warInterval = setInterval(() => {
        spawnWarEffect();
    }, 100); 

    function spawnWarEffect() {
        // Create Laser
        const laser = document.createElement('div');
        laser.className = Math.random() > 0.5 ? 'laser-beam' : 'laser-beam ally-laser';
        
        let startY = Math.random() * window.innerHeight;
        let width = Math.random() * 300 + 100;
        let duration = Math.random() * 0.5 + 0.2;
        
        laser.style.width = width + "px";
        laser.style.top = startY + "px";
        
        if (Math.random() > 0.5) {
            laser.style.left = "-200px";
            laser.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${window.innerWidth + 400}px)` }], { duration: duration * 1000, easing: 'linear' });
        } else {
            laser.style.right = "-200px";
            laser.animate([{ transform: 'translateX(0)' }, { transform: `translateX(-${window.innerWidth + 400}px)` }], { duration: duration * 1000, easing: 'linear' });
        }

        warContainer.appendChild(laser);

        // 🔊 SOUND TRIGGER: Play sound every time a laser appears
        if(window.Sound && Math.random() > 0.6) {
             window.Sound.starSweep(); // Swoosh sound
        }

        setTimeout(() => { laser.remove(); }, duration * 1000);

        // Rare Ship Spawn
        if (Math.random() > 0.9) {
            const ship = document.createElement('div');
            ship.className = 'space-ship';
            ship.style.top = Math.random() * window.innerHeight + "px";
            ship.style.left = "-50px";
            ship.style.opacity = Math.random() * 0.5 + 0.2;
            ship.style.transform = `scale(${Math.random() * 0.5 + 0.5})`;
            
            ship.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${window.innerWidth + 100}px)` }], { duration: 2000, easing: 'ease-out' });
            
            warContainer.appendChild(ship);
            setTimeout(() => { ship.remove(); }, 2000);
        }
    }

    // 3. EXIT SEQUENCE
    setTimeout(() => {
        clearInterval(warInterval); 
        intro.classList.add('warp-out'); 
        
        setTimeout(() => {
            // Start Menu Music pagtapos ng Intro
            window.startStoryMode(); 
        }, 1000); 
    }, 6000); // 6 Seconds Intro Duration
}

// Remove the old 'load' listener since we use the click button now

// --- 📖 STORY & TUTORIAL LOGIC ---

const storyData = [
    {
        text: "<span style='color:#ff0055; font-weight:bold;'>[ UPLINK ESTABLISHED ]</span><br><br>AGENT, DO YOU READ ME? This is Commander Vector. The Nullifiers have shattered the Euclidean perimeter. We are the last surviving bastion of logic.",
        visual: null
    },
    {
        text: "They are entities of pure entropy—feeding on human anxiety and systemic chaos. Conventional weapons are useless. Our only defense is the absolute truth of <span style='color:#00e5ff; font-weight:bold; letter-spacing: 2px;'>PURE MATHEMATICS</span>.",
        visual: null
    },
    {
        text: "You are now synchronized with the N.E.X.U.S. Defense Grid. Your mind is the targeting computer. Solve the algorithmic anomalies on the incoming hostiles to lock your ion cannons and fire.",
        visual: `<div style="padding: 10px; border: 1px dashed #00e5ff; background: rgba(0,229,255,0.1);">
                    <div class="demo-meteor" style="color: #fff; font-size: 24px;">[ 5 + 3 ]</div>
                    <div style="color: #00ff41; margin: 10px 0;">TARGET ACQUIRED</div>
                    <span style="color:#00e5ff; font-family:'Orbitron';">INPUT "8" & EXECUTE [ENTER]</span>
                 </div>`
    },
    {
        text: "<span style='color:#ff0055;'>WARNING:</span> Do not let them breach the lower atmosphere. Every impact destabilizes our core shields. If the math grid falls, humanity goes dark. Permanently.",
        visual: `<div class="blink" style="color:#ff0055; font-size: 18px; font-family: 'Orbitron'; border-top: 2px solid #ff0055; border-bottom: 2px solid #ff0055; padding: 10px 0;">SHIELD INTEGRITY CRITICAL</div>`
    },
    {
        text: "Be advised: Every 5th deployment wave, a <span style='color:#ffd700;'>CLASS-OMEGA MOTHERSHIP</span> will materialize. Their hulls are reinforced with encrypted logic. It will require rapid, chained calculations to shatter their defenses.",
        visual: `<span style="color:#ffd700; font-size: 24px; text-shadow: 0 0 15px #ffd700; font-family:'Orbitron';">⚠️ BOSS ANOMALY DETECTED ⚠️</span>`
    },
    {
        text: "The calculations you make today will echo in eternity. Trust your logic. Trust the numbers. <span style='color:#00ff41;'>Give them nothing but zero.</span><br><br>VECTOR OUT.",
        visual: null
    }
];

let storyIndex = 0;
let isTyping = false;

window.startStoryMode = function() {
    const storyOverlay = document.getElementById('story-overlay');
    const intro = document.getElementById('cinematic-intro'); // Ensure intro is hidden
 
    if(window.Sound) window.Sound.playBGM('menu');
    if (intro) intro.style.display = 'none';
    if (storyOverlay) storyOverlay.classList.remove('hidden');
    
    if(window.Sound) window.Sound.playTone(600, 'sine', 0.1); // Beep
    showStoryStep(0);
};

window.showStoryStep = function(index) {
    if (index >= storyData.length) {
        window.skipStory();
        return;
    }

    storyIndex = index;
    const data = storyData[index];
    const textEl = document.getElementById('story-text');
    const visualEl = document.getElementById('tutorial-visual');
    const btn = document.getElementById('next-story-btn');

    // Reset
    textEl.innerHTML = "";
    visualEl.innerHTML = "";
    visualEl.classList.add('hidden');
    btn.disabled = true; // Disable button while typing
    isTyping = true;

    // Typewriter Effect
    let i = 0;
    const speed = 25; // Mas pinabilis ng konti para astig
    
    // Play voice if available
    if(window.Sound && index === 0) window.Sound.speak("Incoming transmission.");

    // 🟢 GOD-LEVEL TYPEWRITER LOGIC
    let isTag = false;
    let currentHTML = "";

    function type() {
        if (i < data.text.length) {
            let char = data.text.charAt(i);
            currentHTML += char;
            
            // Bypass HTML tags (<span...>) para hindi lumabas ang code nang paunti-unti
            if (char === '<') isTag = true;
            if (char === '>') isTag = false;
            
            // I-inject ang neon cursor sa dulo ng text
            textEl.innerHTML = currentHTML + "<span class='terminal-cursor'></span>";
            
            i++;
            
            // Play typing sound (bawasan ang dalas kung nasa loob ng tag)
            if (!isTag && i % 2 === 0 && window.Sound) {
                window.Sound.playTone(Math.random() * 200 + 800, 'square', 0.02, 0.05); // High-tech terminal clicks
            }
            
            // Mabilis na pag-type kung nasa loob ng HTML tag, normal speed kung text
            setTimeout(type, isTag ? 0 : speed);
        } else {
            isTyping = false;
            btn.disabled = false;
            
            // I-lock ang final text at i-keep ang cursor na nagbi-blink
            textEl.innerHTML = currentHTML + "<span class='terminal-cursor'></span>";
            
            // Show Visual if exists
            if (data.visual) {
                visualEl.innerHTML = data.visual;
                visualEl.classList.remove('hidden');
                if(window.Sound) window.Sound.playTone(400, 'sine', 0.2); 
            }
        }
    }
    type();
};

window.nextStoryStep = function() {
    if (isTyping) {
        // Instant finish typing
        // (Optional feature to skip typing animation)
        return;
    }
    if(window.Sound) window.Sound.click();
    window.showStoryStep(storyIndex + 1);
};

window.skipStory = function() {
    if(window.Sound) window.Sound.click();
    const storyOverlay = document.getElementById('story-overlay');
    if (storyOverlay) {
        storyOverlay.classList.add('hidden');
        // Show Start Modal (Main Menu)
        document.getElementById('start-modal').classList.remove('hidden');
        
        // Check for saved session AFTER story/intro
        if(window.restoreSession) window.restoreSession();
    }
};

// Keyboard shortcut for Story
document.addEventListener("keydown", function(event) {
    const storyOverlay = document.getElementById('story-overlay');
    if (storyOverlay && !storyOverlay.classList.contains('hidden')) {
        if (event.key === "Enter") {
            window.nextStoryStep();
        }
    }
});

window.renderTacticalLog = function() {
    const logContainer = document.getElementById("mistakes-log");
    if (!logContainer) return;
    
    const history = state.gameHistory || [];

    if (history.length === 0) {
        logContainer.innerHTML = `
            <div style="text-align:center; color:#888; padding:40px; border:1px dashed #444; border-radius: 8px;">
                <h2 style="font-family:'Orbitron'; color:#555;">NO DATA RECORDED</h2>
                <p>Battle has not started or no inputs were detected.</p>
            </div>`;
        return;
    } 
    
    logContainer.innerHTML = ""; 
    history.slice().reverse().forEach((item, index) => {
        if (!item || !item.q) return; // 🟢 Anti-crash safeguard
        
        let isCorrect = item.status === 'correct';
        let color = isCorrect ? '#00ff41' : (item.status === 'missed' ? '#ff0055' : '#ffd700'); 
        let label = item.status ? item.status.toUpperCase() : 'UNKNOWN';
        
        let qDisplay = item.q;
        let correctDisplay = item.a !== undefined ? item.a : "?";
        let userIn = item.input || '-';

        // Safe evaluation
        let explanation = "Review math rules.";
        try {
            if (window.getExplanation) explanation = window.getExplanation(qDisplay.toString(), correctDisplay);
        } catch(e) {}
        
        let uniqueId = `rev-${index}`;

        let html = `
            <div style="border-left: 4px solid ${color}; background: rgba(0,0,0,0.6); margin-bottom: 10px; padding: 15px; border-radius: 4px; border-bottom: 1px solid #222;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <div style="color:white; font-size:22px; font-family:'Orbitron';">
                            ${qDisplay} <span style="color:#888;">=</span> <span style="color:${isCorrect?'#00ff41':'#ffd700'}">${correctDisplay}</span>
                        </div>
                        <div style="font-size:12px; color:#aaa; margin-top:5px;">YOU TYPED: <span style="color:${isCorrect?'#fff':'#ff5555'}; font-weight:bold;">${userIn}</span></div>
                    </div>
                    <div style="text-align:right;">
                        <div style="color:${color}; font-weight:bold; font-size:12px; letter-spacing:1px; margin-bottom:8px;">${label}</div>
                        <button class="btn text-only" style="padding:4px 10px; font-size:10px; border:1px solid ${color}; color:${color}; margin:0;" onclick="document.getElementById('${uniqueId}').classList.toggle('hidden')">
                            ${isCorrect ? '🔍 ANALYZE' : '💡 SOLUTION'}
                        </button>
                    </div>
                </div>
                <div id="${uniqueId}" class="hidden" style="margin-top:15px; padding:15px; background:rgba(255, 255, 255, 0.05); border-left:2px solid ${color}; color:#ddd; font-size:14px; font-family:'Courier New'; white-space: pre-wrap;">${explanation}</div>
            </div>`;
        logContainer.innerHTML += html;
        
    });
};

// 🟢 Idagdag ang render call na ito sa pinakadulo ng window.gameOver function mo:
// Hanapin ang window.gameOver function at bago ito matapos (sa loob ng setTimeout kung may cinematic), idagdag ang:
// window.renderTacticalLog();

// --- 🎖️ MISSION DEBRIEF SYSTEM (Capstone Feature) ---
window.generateMissionDebrief = function() {
    const rankEl = document.getElementById('debrief-rank');
    const msgEl = document.getElementById('debrief-msg');
    
    if (!rankEl || !msgEl) return;

    // 1. Calculate Accuracy
    let totalHits = Math.floor(state.score / 10);
    let totalMisses = state.mistakes ? state.mistakes.length : 0;
    let totalAttempts = totalHits + totalMisses;
    let accuracy = totalAttempts > 0 ? (totalHits / totalAttempts) * 100 : 0;
    
    // 2. Determine Rank & Narrative
    let rankTitle = "ROOKIE PILOT";
    let message = "System integrity critical. Simulation training recommended.";
    let rankClass = "rank-d";
    let voiceMsg = "Mission failed. Return to training.";

    if (accuracy >= 95 && state.maxCombo > 20) {
        rankTitle = "🌌 GALACTIC GUARDIAN";
        message = "Outstanding performance, Commander! The Nullifiers didn't stand a chance.";
        rankClass = "rank-s";
        voiceMsg = "Legendary performance. You are a Galactic Guardian.";
    } 
    else if (accuracy >= 85) {
        rankTitle = "🚀 ACE DEFENDER";
        message = "High combat efficiency detected. Sector is secure.";
        rankClass = "rank-a";
        voiceMsg = "Excellent shooting. Sector secure.";
    }
    else if (accuracy >= 70) {
        rankTitle = "🛡️ OFFICER";
        message = "Mission successful, but hull damage sustained. Review your calculations.";
        rankClass = "rank-b";
        voiceMsg = "Mission accomplished. Review protocols.";
    }
    else if (accuracy >= 50) {
        rankTitle = "🔧 RECRUIT";
        message = "Systems unstable. You survived, but we need better precision.";
        rankClass = "rank-c";
        voiceMsg = "Systems unstable. Focus on accuracy.";
    }

    // 3. Update UI
    rankEl.innerText = rankTitle;
    rankEl.className = rankClass; // Reset class and add new one
    msgEl.innerText = `"${message}"`;
    
    // 4. Voice Feedback (Immersion)
    if(window.Sound) window.Sound.speak(voiceMsg);
};

// ==========================================
// 🛒 SHOP SYSTEM & ECONOMY MODULE
// ==========================================

// 1. DATA CATALOG
const shopCatalog = {
    ships: [
        { id: 'turret_def', subtype: 'turret', name: 'Standard Issue', price: 0, img: 'ship_default.png', desc: 'Reliable. Standard.' },
        { id: 'turret_gold', subtype: 'turret', name: 'Golden Falcon', price: 5000, img: 'ship_gold.png', desc: 'Prestige Class.' },
        { id: 'turret_cyber', subtype: 'turret', name: 'Cyber Wing', price: 2500, img: 'ship_cyber.png', desc: 'Neon Aero-dynamics.' },
        { id: 'turret_tank', subtype: 'turret', name: 'Heavy Mecha', price: 8000, img: 'ship_tank.png', desc: 'Built like a tank.' },
        
        { id: 'enemy_def', subtype: 'enemy', name: 'Asteroid', price: 0, img: 'enemy_default.png', desc: 'Standard Threat.' },
        { id: 'enemy_alien', subtype: 'enemy', name: 'Xenomorph', price: 1500, img: 'enemy_alien.png', desc: 'Bio-organic Hull.' },
        { id: 'enemy_glitch', subtype: 'enemy', name: 'System Glitch', price: 3000, img: 'enemy_glitch.png', desc: 'Corrupted Data.' },

        { id: 'boss_def', subtype: 'boss', name: 'Omega Core', price: 0, img: 'boss_mech.png', desc: ' The Original.' },
        { id: 'boss_god', subtype: 'boss', name: 'Cosmic Horror', price: 10000, img: 'boss_god.png', desc: 'Eldritch Nightmare.' }
    ],
    upgrades: [
        { id: 'upgrade_coin', name: 'Crypto Miner', basePrice: 500, maxLevel: 5, desc: '+1 Coin per kill/level', img: 'supply_crate.png' },
        { id: 'upgrade_score', name: 'Data Processor', basePrice: 800, maxLevel: 5, desc: '+5% Score/level', img: 'supply_crate.png' },
        { id: 'upgrade_health', name: 'Hull Reinforcement', basePrice: 1000, maxLevel: 10, desc: '+10 Max HP/level', img: 'supply_crate.png' }
    ],
    fx: [
        { id: 'fx_blue', name: 'System Default', price: 0, color: '#00e5ff', aura: 'none', desc: 'Standard Ion Beam.' },
        { id: 'fx_red', name: 'Crimson Fury', price: 1000, color: '#ff0055', aura: 'fire', desc: 'Red Laser + Fire Aura.' },
        { id: 'fx_green', name: 'Toxic Waste', price: 1500, color: '#00ff41', aura: 'void', desc: 'Green Laser + Void Mist.' },
        { id: 'fx_gold', name: 'Divine Power', price: 5000, color: '#ffd700', aura: 'lightning', desc: 'Gold Laser + Lightning.' }
    ]
};

let currentShopTab = 'ships';

// ==========================================
// 🐾 CYBER-COMPANION (PET) DATABASE
// ==========================================
const petCatalog = {
    common: [
        { id: 'pet_c1', name: 'Data-Pug', rarity: 'Common', class: 'Scavenger', affinity: '+', desc: '+5% Coins in Addition levels.', icon: '🐶' },
        { id: 'pet_c2', name: 'Calc-Bot', rarity: 'Common', class: 'Guardian', affinity: '-', desc: 'Absorbs 1 mistake per game.', icon: '🤖' }
    ],
    rare: [
        { id: 'pet_r1', name: 'Holo-Cat', rarity: 'Rare', class: 'Chrono', affinity: 'x', desc: '+2 Secs to Slow Time.', icon: '🐱' },
        { id: 'pet_r2', name: 'Neon-Owl', rarity: 'Rare', class: 'Scavenger', affinity: '÷', desc: '+15% Coins & XP.', icon: '🦉' }
    ],
    epic: [
        { id: 'pet_e1', name: 'Aegis Turtle', rarity: 'Epic', class: 'Guardian', affinity: 'All', desc: 'Absorbs 3 mistakes. Grants shield.', icon: '🐢' },
        { id: 'pet_e2', name: 'Sniper Falcon', rarity: 'Epic', class: 'Striker', affinity: 'All', desc: 'Fires auto-laser at 15x Combo.', icon: '🦅' }
    ],
    legendary: [
        { id: 'pet_l1', name: 'Star-Forged Griffin', rarity: 'Legendary', class: 'Striker', affinity: 'All', desc: 'Fires auto-laser at 10x Combo. +30% Score.', icon: '🪽' },
        { id: 'pet_l2', name: 'Cyber-Dragon', rarity: 'Legendary', class: 'Scavenger', affinity: 'All', desc: '+50% Coins. Double XP on Algebra.', icon: '🐉' }
    ],
    mythic: [
        { id: 'pet_m1', name: 'VOID LEVIATHAN', rarity: 'Mythic', class: 'God', affinity: 'All', desc: 'Auto-destroys 1 enemy every 5 secs. +100% Score.', icon: '👁️‍🗨️' },
        { id: 'pet_m2', name: 'GLITCH ENTITY', rarity: 'Mythic', class: 'God', affinity: 'All', desc: 'Hacks the system. Immortal Combo Shield.', icon: '👾' }
    ]
};

// ==========================================
// 🎰 THE INCUBATOR GACHA ENGINE (0.01% Drop Rate + Pity)
// ==========================================

// Tinitingnan at inaayos ang User Data para sa Pets
function initPetData() {
    if (currentUser) {
        if (!currentUser.pets) currentUser.pets = [];
        if (!currentUser.equippedPet) currentUser.equippedPet = null;
        if (!currentUser.gachaPulls) currentUser.gachaPulls = 0; // Pity System Counter
    }
}

window.openIncubator = function() {
    if(window.Sound) window.Sound.click();
    initPetData();
    // I-hide ang main menu, Ipakita ang Incubator Modal (Gagawa tayo ng HTML nito sa Step 2)
    document.getElementById("start-modal").classList.add("hidden");
    document.getElementById("incubator-modal").classList.remove("hidden");
    updateIncubatorUI();
};

window.closeIncubator = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("incubator-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.remove("hidden");
};

function updateIncubatorUI() {
    document.getElementById("inc-coin-display").innerText = state.coins;
    let pity = currentUser.gachaPulls || 0;
    
    // Update Pity Bar (Guarantee at 1000 pulls)
    let pityPercent = Math.min(100, (pity / 1000) * 100);
    const pityFill = document.getElementById("pity-bar-fill");
    if (pityFill) pityFill.style.width = pityPercent + "%";
    document.getElementById("pity-text").innerText = `MYTHIC GUARANTEE: ${pity} / 1000`;
}

// 🟢 THE CORE ALGORITHM WITH AUTO-LEVELING & GLOBAL BROADCAST
window.buyCyberCore = async function(cost, isPremium) {
    if (state.coins < cost) {
        if(window.Sound) window.Sound.error();
        alert("INSUFFICIENT COINS TO DECRYPT CORE.");
        return;
    }

    state.coins -= cost;
    if (!currentUser.gachaPulls) currentUser.gachaPulls = 0;
    currentUser.gachaPulls += 1;
    let currentPity = currentUser.gachaPulls;
    
    if(window.Sound) window.Sound.playBGM('battle'); 
    
    document.getElementById("incubator-buttons").classList.add("hidden");
    document.getElementById("incubator-animation").classList.remove("hidden");
    document.getElementById("incubator-animation").innerHTML = `<div class="shake-core">🥚<br><span style="font-size:12px; color:cyan;">DECRYPTING...</span></div>`;

    // 🎰 ROLL THE DICE
    let roll = Math.random(); 
    let rarityGained = 'common';
    let pColor = 'white';

    if (currentPity >= 1000) {
        rarityGained = 'mythic';
        currentUser.gachaPulls = 0; // Reset pity
    } 
    else {
        if (isPremium) {
            if (roll < 0.60) rarityGained = 'rare';             
            else if (roll < 0.90) rarityGained = 'epic';        
            else if (roll < 0.995) rarityGained = 'legendary';  
            else rarityGained = 'mythic';                       
        } else {
            if (roll < 0.70) rarityGained = 'common';           
            else if (roll < 0.90) rarityGained = 'rare';        
            else if (roll < 0.9899) rarityGained = 'epic';      
            else if (roll < 0.9999) rarityGained = 'legendary'; 
            else rarityGained = 'mythic';                       
        }
    }

    let possiblePets = petCatalog[rarityGained];
    let wonPet = possiblePets[Math.floor(Math.random() * possiblePets.length)];

    if (rarityGained === 'rare') pColor = '#00e5ff';
    if (rarityGained === 'epic') pColor = '#b000ff';
    if (rarityGained === 'legendary') pColor = '#ffd700';
    if (rarityGained === 'mythic') pColor = '#ff0055';

    setTimeout(async () => {
        if(window.Sound) {
            if (rarityGained === 'mythic' || rarityGained === 'legendary') window.Sound.nuke();
            else window.Sound.powerup();
        }

        // 🟢 THE LEVELING LOGIC (Scrap to Upgrade)
        if (!currentUser.petLevels) currentUser.petLevels = {};
        
        let isDuplicate = currentUser.pets.includes(wonPet.id);
        let currentLvl = currentUser.petLevels[wonPet.id] || 1;
        let levelMsg = "";

        if (isDuplicate) {
            currentUser.petLevels[wonPet.id] = currentLvl + 1; // Level UP!
            levelMsg = `<div style="color:#00ff41; font-weight:bold; font-size:14px; margin-top:5px; animation:blink 1s infinite;">DUPLICATE DETECTED! UPGRADED TO LVL ${currentLvl + 1}</div>`;
        } else {
            currentUser.pets.push(wonPet.id);
            currentUser.petLevels[wonPet.id] = 1;
            levelMsg = `<div style="color:#ffd700; font-weight:bold; font-size:14px; margin-top:5px;">NEW COMPANION ACQUIRED!</div>`;
        }

        // Save to Firebase
        await updateDoc(doc(db, "users", currentUser.uid), {
            coins: state.coins,
            gachaPulls: currentUser.gachaPulls,
            pets: currentUser.pets,
            petLevels: currentUser.petLevels
        });

        // 📢 GLOBAL BROADCASTER TRIGGER (Para sa Legendary at Mythic)
        if ((rarityGained === 'legendary' || rarityGained === 'mythic') && socket) {
            socket.emit('send_global_msg', {
                text: `⚠️ [SYSTEM OVERLOAD]: AGENT ${currentUser.username.toUpperCase()} HAS AWAKENED THE ${rarityGained.toUpperCase()} COMPANION [${wonPet.name.toUpperCase()}]!`,
                color: pColor
            });
        }

        // UI Reveal
        document.getElementById("incubator-animation").innerHTML = `
            <div class="pet-reveal" style="text-shadow: 0 0 20px ${pColor};">
                <div style="font-size: 80px;">${wonPet.icon}</div>
                <h2 style="color:${pColor}; font-family:'Orbitron'; margin:0;">${wonPet.name}</h2>
                <span style="font-size:12px; color:#fff; background:${pColor}; padding:2px 5px; border-radius:3px;">${wonPet.rarity.toUpperCase()}</span>
                ${levelMsg}
                <p style="color:#aaa; font-size:12px; font-family:'Rajdhani'; margin-top:10px;">${wonPet.desc}</p>
            </div>
            <button class="btn primary" style="margin-top:20px;" onclick="resetIncubator()">CLAIM</button>
        `;
        
        updateIncubatorUI();
        if(window.updateHUD) window.updateHUD(); 

    }, 2500);
};

window.resetIncubator = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("incubator-animation").classList.add("hidden");
    document.getElementById("incubator-buttons").classList.remove("hidden");
    if(window.Sound) window.Sound.playBGM('menu'); // Balik sa chill music
};

// 2. OPEN SHOP
window.openShop = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("start-modal").classList.add("hidden");
    document.getElementById("shop-modal").classList.remove("hidden");
    
    // Update visual coin balance
    document.getElementById("shop-coin-display").innerText = state.coins;
    
    // Default Tab
    window.switchShopTab('ships');
};

// 3. CLOSE SHOP
window.closeShop = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("shop-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.remove("hidden");
};

// 4. SWITCH TABS
window.switchShopTab = function(tab) {
    if(window.Sound) window.Sound.click();
    currentShopTab = tab;
    
    // Update Buttons
    document.querySelectorAll('.shop-tabs .tab-btn').forEach(btn => btn.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    
    // Show/Hide Filter
    const filterContainer = document.getElementById('shop-filter-container');
    if (filterContainer) filterContainer.style.display = (tab === 'ships') ? 'block' : 'none';
    
    window.renderShopGrid();
};

// 5. RENDER GRID (The Visual Cards) - UPDATED FOR PETS
window.renderShopGrid = function() {
    const grid = document.getElementById('shop-grid');
    if (!grid) return;
    grid.innerHTML = "";

    let items = [];
    
    // 🟢 PETS LOGIC (Hahanapin lahat ng pets sa catalog)
    if (currentShopTab === 'pets') {
        items = [
            ...petCatalog.common, 
            ...petCatalog.rare, 
            ...petCatalog.epic, 
            ...petCatalog.legendary, 
            ...petCatalog.mythic
        ];
    } else {
        items = shopCatalog[currentShopTab] || [];
    }
    
    // Filter Ships Logic
    if (currentShopTab === 'ships') {
        const filterVal = document.getElementById('shop-ship-filter').value;
        items = items.filter(i => i.subtype === filterVal);
    }

    const userInv = (currentUser && currentUser.inventory) ? currentUser.inventory : ['turret_def', 'enemy_def', 'boss_def', 'fx_blue'];
    const userPets = (currentUser && currentUser.pets) ? currentUser.pets : []; // Nakuha sa Gacha
    const equipped = state.equipped || {};
    const upgrades = state.upgradeLevels || {};

    items.forEach(item => {
        let cardHTML = "";
        
        // --- UPGRADE CARD ---
        if (currentShopTab === 'upgrades') {
            let currentLvl = upgrades[item.id] || 0;
            let isMaxed = currentLvl >= item.maxLevel;
            let nextPrice = item.basePrice * (currentLvl + 1);
            let progressPercent = (currentLvl / item.maxLevel) * 100;
            
            let btnHTML = isMaxed 
                ? `<button class="shop-btn btn-equipped">MAX LEVEL</button>` 
                : `<button class="shop-btn btn-buy" onclick="window.buyItem('${item.id}', 'upgrade')">UPGRADE (${nextPrice})</button>`;

            cardHTML = `
                <div class="shop-item">
                    <img src="${item.img}" onerror="this.src='supply_crate.png'">
                    <h4>${item.name}</h4>
                    <div class="level-text"><span>Lvl ${currentLvl}</span><span>Max ${item.maxLevel}</span></div>
                    <div class="upgrade-track"><div class="upgrade-fill" style="width: ${progressPercent}%"></div></div>
                    <div class="price" style="font-size:12px; color:#aaa;">${item.desc}</div>
                    ${btnHTML}
                </div>`;
        } 
        // --- PET COMPANION CARD ---
        else if (currentShopTab === 'pets') {
            let isOwned = userPets.includes(item.id);
            let isEquipped = (equipped.pet === item.id);
            
            // Color Coding base sa Rarity
            let rColor = '#fff';
            if (item.rarity === 'Rare') rColor = '#00e5ff';
            if (item.rarity === 'Epic') rColor = '#b000ff';
            if (item.rarity === 'Legendary') rColor = '#ffd700';
            if (item.rarity === 'Mythic') rColor = '#ff0055';

            let btnHTML = "";
            if (isEquipped) btnHTML = `<button class="shop-btn btn-equipped">EQUIPPED</button>`;
            else if (isOwned) btnHTML = `<button class="shop-btn btn-equip" onclick="window.equipItem('${item.id}', 'pet')">EQUIP COMPANION</button>`;
            else btnHTML = `<button class="shop-btn" style="background:#222; color:#555; border:1px solid #333;" onclick="window.closeShop(); window.openIncubator()">GO TO INCUBATOR</button>`;

            cardHTML = `
                <div class="shop-item ${isOwned ? 'owned' : ''} ${isEquipped ? 'equipped' : ''}" style="${isOwned ? 'border-color:' + rColor + ';' : 'opacity:0.6; filter:grayscale(1);'}">
                    <div style="font-size:50px; text-shadow: 0 0 20px ${rColor}; margin:10px 0;">${item.icon}</div>
                    <h4 style="color:${rColor}">${item.name} <span style="color:#fff; font-size:10px;">(LVL ${currentUser.petLevels ? (currentUser.petLevels[item.id] || 0) : 0})</span></h4>
                    <div style="font-size:10px; background:${rColor}; color:#000; padding:2px 5px; border-radius:3px; display:inline-block; margin-bottom:5px;">${item.rarity.toUpperCase()}</div>
                    <div class="price" style="font-size:11px; color:#ccc; min-height:30px;">${item.desc}</div>
                    ${btnHTML}
                </div>`;
        }
        // --- ITEM/SKIN CARD ---
        else {
            let isOwned = userInv.includes(item.id) || item.price === 0;
            let isEquipped = false;
            
            if (currentShopTab === 'ships') {
                if (equipped[item.subtype] === item.id) isEquipped = true;
            } else if (currentShopTab === 'fx') {
                if (equipped.fx === item.id) isEquipped = true;
            }

            let btnHTML = "";
            if (isEquipped) btnHTML = `<button class="shop-btn btn-equipped">EQUIPPED</button>`;
            else if (isOwned) {
                let slot = currentShopTab === 'ships' ? item.subtype : 'fx';
                btnHTML = `<button class="shop-btn btn-equip" onclick="window.equipItem('${item.id}', '${slot}')">EQUIP</button>`;
            } else {
                btnHTML = `<button class="shop-btn btn-buy" onclick="window.buyItem('${item.id}', 'item', ${item.price})">BUY (${item.price})</button>`;
            }

            let visualPreview = (currentShopTab === 'fx') 
                ? `<div class="fx-preview" style="background:${item.color}; box-shadow: 0 0 15px ${item.color}; border: 2px solid white;"></div>`
                : `<img src="${item.img}" onerror="this.src='ship_default.png'">`;

            cardHTML = `
                <div class="shop-item ${isOwned ? 'owned' : ''} ${isEquipped ? 'equipped' : ''}">
                    ${visualPreview}
                    <h4>${item.name}</h4>
                    <div class="price" style="font-size:12px; color:#ffd700;">${isOwned ? 'OWNED' : item.price + ' COINS'}</div>
                    ${btnHTML}
                </div>`;
        }
        grid.innerHTML += cardHTML;
    });
};

// 6. BUY FUNCTION (FIXED: Auto-Calculates Stats & Syncs UI)
window.buyItem = async function(itemId, type, priceOverride) {
    let price = 0;
    let itemRef = null;

    if (type === 'upgrade') {
        itemRef = shopCatalog.upgrades.find(i => i.id === itemId);
        if (!itemRef) return;
        let currentLvl = (state.upgradeLevels && state.upgradeLevels[itemId]) || 0;
        if (currentLvl >= itemRef.maxLevel) return;
        price = itemRef.basePrice * (currentLvl + 1);
    } else {
        let allItems = [...shopCatalog.ships, ...shopCatalog.fx];
        itemRef = allItems.find(i => i.id === itemId);
        price = priceOverride;
    }

    if (state.coins < price) { alert("INSUFFICIENT FUNDS!"); if(window.Sound) window.Sound.error(); return; }
    if (!confirm(`Purchase for ${price} coins?`)) return;

    // --- EXECUTE TRANSACTION ---
    state.coins -= price;
    if(window.Sound) window.Sound.powerup();

    if (type === 'upgrade') {
        if (!state.upgradeLevels) state.upgradeLevels = {};
        if (!state.upgradeLevels[itemId]) state.upgradeLevels[itemId] = 0;
        state.upgradeLevels[itemId]++;
        
        // 🚨 CRITICAL FIX: Update Stats IMMEDIATELY
        if(window.applyUpgradeStats) window.applyUpgradeStats(); 
    } else {
        if (!currentUser) currentUser = { inventory: [] };
        if (!currentUser.inventory) currentUser.inventory = [];
        currentUser.inventory.push(itemId);
    }

    // --- REFRESH UI LAYERS ---
    window.renderShopGrid();
    document.getElementById("shop-coin-display").innerText = state.coins;
    
    // Update Main HUD behind modal
    if(window.updateHUD) window.updateHUD(); 

    // --- SAVE TO DB ---
    if (currentUser && currentUser.uid) {
        const userRef = doc(db, "users", currentUser.uid);
        let updatePayload = { coins: state.coins };
        if (type === 'upgrade') updatePayload.upgradeLevels = state.upgradeLevels;
        else updatePayload.inventory = currentUser.inventory;
        await updateDoc(userRef, updatePayload).catch(e => console.log("Save fail:", e));
    }
};

// 7. EQUIP FUNCTION
window.equipItem = async function(itemId, slot) {
    if(window.Sound) window.Sound.click();

    // Update Local State
    if (!state.equipped) state.equipped = {};
    state.equipped[slot] = itemId; 
    
    // Update User Profile
    if (currentUser) {
        if (!currentUser.equipped) currentUser.equipped = {};
        currentUser.equipped[slot] = itemId;
    }

    // Refresh UI
    window.renderShopGrid();

    // Save to DB
    if (currentUser && currentUser.uid) {
        const userRef = doc(db, "users", currentUser.uid);
        await updateDoc(userRef, { equipped: state.equipped });
    }
};

// 8. DATA SYNC & CALCULATORS
window.syncShopData = function(userData) {
    if (userData.coins) state.coins = userData.coins;
    if (userData.inventory) currentUser.inventory = userData.inventory;
    if (userData.equipped) state.equipped = userData.equipped;
    if (userData.upgradeLevels) state.upgradeLevels = userData.upgradeLevels;
    
    if (!state.equipped) state.equipped = { turret:'turret_def', enemy:'enemy_def', boss:'boss_def', fx:'fx_blue' };
    if (!state.upgradeLevels) state.upgradeLevels = { upgrade_coin:0, upgrade_score:0, upgrade_health:0 };

    // Apply stats immediately upon load
    window.applyUpgradeStats();
    if(window.updateHUD) window.updateHUD();
};

window.applyUpgradeStats = function() {
    if (state.gameMode === 'classroom') {
        state.coinBonus = 0; state.scoreMultiplier = 1; return;
    }
    let levels = state.upgradeLevels || {};
    
    // Base Health = 100. Each level adds 10 HP.
    state.health = 100 + ((levels.upgrade_health || 0) * 10); 
    
    // Coin Bonus (e.g. +1 per kill)
    state.coinBonus = (levels.upgrade_coin || 0);
    
    // Score Multiplier (e.g. +5% per level)
    state.scoreMultiplier = 1 + ((levels.upgrade_score || 0) * 0.05);
};

// ==========================================
// 🛠️ DEVELOPER TOOLS (CHEAT CODES)
// ==========================================

window.devGiveMoney = async function() {
    // Check if user is logged in
    if (!currentUser || !currentUser.uid) {
        console.log("❌ ERROR: No user logged in.");
        return;
    }

    // Check permissions (Optional: Ikaw lang ang pwede gumamit)
    const allowedEmails = ["jesstergirado@gmail.com", "stockfishvshumans@gmail.com", "tester2@gmail.com"];
    if (!allowedEmails.includes(currentUser.email)) {
        console.log("🚫 ACCESS DENIED: Developer only.");
        return;
    }

    // 1. Update Local State
    state.coins = 1000000;
    
    // 2. Update UI
    if(window.updateHUD) window.updateHUD();
    const shopCoinDisplay = document.getElementById("shop-coin-display");
    if(shopCoinDisplay) shopCoinDisplay.innerText = state.coins;

    // 3. Save to Firebase Database
    console.log("💾 SAVING 1,000,000 COINS TO DB...");
    try {
        const userRef = doc(db, "users", currentUser.uid);
        await updateDoc(userRef, { coins: 1000000 });
        console.log("✅ SUCCESS! You are now rich.");
        if(window.Sound) window.Sound.powerup();
        alert("DEV COMMAND: 1,000,000 COINS ADDED!");
    } catch (e) {
        console.error("Save failed:", e);
    }
};

// ==========================================
// 📖 THE ANCIENT CODEX (REALISTIC BOOK ENGINE)
// ==========================================

// 1. PAPER SOUND SYNTHESIZER (No MP3 needed!)
window.playPageTurnSound = function() {
    // Check global sound settings
    if(window.Sound && window.Sound.isMuted) return;
    
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    
    // Create "White Noise" Buffer for the swish sound
    const bufferSize = ctx.sampleRate * 0.5; // 0.5 seconds duration
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    
    // Filter to make it sound like paper (Lowpass)
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;

    // Envelope for "Swish" volume curve
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

    // Connect nodes
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    
    noise.start();
};

// 2. BOOK CONTENT DATA (EXPANDED TO 30 CHAPTERS + AUTHOR PAGE)
const codexData = [
    {
        title: "INTRODUCTION",
        content: `
            <p><b>Greetings, Commander.</b></p>
            <p>You hold the <i>Lost Codex of Logic</i>. Recovered from the ruins of the Old World, it contains the mathematical code that governs reality.</p>
            <p>The Nullifiers feed on math anxiety. To defeat them, you must turn numbers into weapons.</p>
            <div class="tip-box">
                Use "A" / "D" or the UI buttons to navigate. Knowledge is your greatest armor.
            </div>
            <br>
            <center><i>"Accuracy is the ultimate weapon."</i></center>
        `
    },
    {
        title: "CH 1: THE ZERO PRINCIPLE",
        content: `
            <h2>Identity vs. Destroyer</h2>
            <p><b>Addition:</b> Zero is an <i>Identity</i>. <code>N + 0 = N</code>. It adds nothing to the strength of your fleet.</p>
            <p><b>Multiplication:</b> Zero is the <i>Destroyer</i>. <code>N x 0 = 0</code>.</p>
            <div class="tip-box">
                💀 <b>TACTIC:</b> If a target has a zero in a multiplication string, the answer is instantly 0. Don't waste time calculating the other numbers!
            </div>
        `
    },
    {
        title: "CH 2: SIGNED NUMBERS (WAR)",
        content: `
            <h2>Positive vs. Negative</h2>
            <p>Think of <b>Positive (+)</b> as Allies and <b>Negative (-)</b> as Enemy Damage.</p>
            <ul>
                <li><b>Same Signs:</b> They join forces. Add them up. (<code>-5 + -3 = -8</code>)</li>
                <li><b>Opposite Signs:</b> They fight! Subtract the smaller from the larger. The winner keeps their sign.</li>
            </ul>
            <div class="tip-box">
                <code>-12 + 5</code> -> 12 enemies vs 5 allies. Enemies win by 7. Result: <b>-7</b>.
            </div>
        `
    },
    {
        title: "CH 3: MULTIPLYING SIGNS",
        content: `
            <h2>Social Logic</h2>
            <ul>
                <li><b>(+) x (+) = (+)</b>: A friend of a friend is a friend.</li>
                <li><b>(-) x (-) = (+)</b>: An enemy of an enemy is a friend.</li>
                <li><b>(+) x (-) = (-)</b>: A friend of an enemy is an enemy.</li>
            </ul>
            <p><b>DEEP TRICK:</b> Count the negative signs. If the number of negatives is <b>EVEN</b>, the answer is positive. If <b>ODD</b>, it's negative.</p>
        `
    },
    {
        title: "CH 4: THE PEMDAS HIERARCHY",
        content: `
            <h2>Order of Operations</h2>
            <p>The universe follows a rank. Follow it or your ship will explode:</p>
            <ol>
                <li><b>P</b>arentheses <code>()</code></li>
                <li><b>E</b>xponents <code>x²</code></li>
                <li><b>M/D</b> Multiply/Divide (Left to Right)</li>
                <li><b>A/S</b> Add/Subtract (Left to Right)</li>
            </ol>
            <div class="tip-box">
                <b>BEWARE:</b> Addition does NOT always come before Subtraction. They share the same rank!
            </div>
        `
    },
    {
        title: "CH 5: FRACTIONAL ARMOR",
        content: `
            <h2>The "Straight Across" Rule</h2>
            <p>In <b>Multiplication</b>, don't overthink. Just multiply the tops and the bottoms.</p>
            <p><code>(2/3) x (4/5) = 8/15</code></p>
            <br>
            <h2>The "KCF" Tactic</h2>
            <p>For <b>Division</b>, use <b>Keep-Change-Flip</b>.</p>
            <p><code>(1/2) ÷ (1/4)</code> -> Keep 1/2, Change to (x), Flip 1/4 to 4/1. Result: <b>2</b>.</p>
        `
    },
    {
        title: "CH 6: DECIMAL DRIFT",
        content: `
            <h2>Multiplying Decimals</h2>
            <p>Forget the dots at first. Multiply like whole numbers.</p>
            <p><code>0.2 x 0.03</code> -> Think <code>2 x 3 = 6</code>.</p>
            <p>Then, count the total decimal places (1 + 2 = 3).</p>
            <p>Move the dot 3 times: <b>0.006</b>.</p>
        `
    },
    {
        title: "CH 7: THE 11-BURST HACK",
        content: `
            <h2>Rapid Fire x11</h2>
            <p>Multiply any 2-digit number by 11 in 1 second.</p>
            <p>Target: <code>45 x 11</code></p>
            <ol>
                <li>Split the digits: <b>4 ... 5</b></li>
                <li>Add them: <code>4 + 5 = 9</code></li>
                <li>Put the sum in the middle: <b>495</b></li>
            </ol>
            <div class="tip-box">
                If the sum is 10 or more, carry the 1 to the first digit!
            </div>
        `
    },
    {
        title: "CH 8: SQUARE ENDING IN 5",
        content: `
            <h2>The "Next-Up" Trick</h2>
            <p>Square numbers ending in 5 (25, 35, 75) instantly.</p>
            <p>Target: <code>65²</code></p>
            <ol>
                <li>Take the first digit (6).</li>
                <li>Multiply by the next number (7). <code>6 x 7 = 42</code>.</li>
                <li>Attach <b>25</b> at the end.</li>
            </ol>
            <p>Result: <b>4225</b>.</p>
        `
    },
    {
        title: "CH 9: PERCENTAGE SWAP",
        content: `
            <h2>The Mirror Rule</h2>
            <p><code>X% of Y</code> is the SAME as <code>Y% of X</code>.</p>
            <p><b>Hard:</b> 16% of 50?</p>
            <p><b>Easy:</b> 50% of 16? (Half of 16) -> <b>8</b>.</p>
            <div class="tip-box">
                Always swap if one number is "cleaner" (like 10, 25, 50).
            </div>
        `
    },
    {
        title: "CH 10: DIVISIBILITY SCAN",
        content: `
            <h2>Target Identification</h2>
            <ul>
                <li><b>Rule of 3:</b> If the sum of digits is divisible by 3, the whole number is.</li>
                <li><b>Rule of 4:</b> If the last two digits are divisible by 4.</li>
                <li><b>Rule of 9:</b> If the sum of digits is divisible by 9.</li>
            </ul>
            <p>Example: <code>1,233</code>. Sum: 1+2+3+3 = 9. It is divisible by 3 AND 9!</p>
        `
    },
    {
        title: "CH 11: ALGEBRAIC ISOLATION",
        content: `
            <h2>The Inverse Key</h2>
            <p>Algebra is just a locked chest. To find <b>X</b>, use the <b>Opposite</b> tool.</p>
            <ul>
                <li>(+) locked? Use (-)</li>
                <li>(÷) locked? Use (x)</li>
            </ul>
            <p><code>x - 10 = 50</code> -> Move -10 over as +10. <b>x = 60</b>.</p>
        `
    },
    {
        title: "CH 12: COMBINING TERMS",
        content: `
            <h2>Liking the Troops</h2>
            <p>You can only combine "Like Terms" (Same variables/powers).</p>
            <p><code>3x + 2y + 5x</code></p>
            <p>Think: 3 X-wings + 2 Y-wings + 5 X-wings.</p>
            <p>Total: <b>8x + 2y</b>.</p>
        `
    },
    {
        title: "CH 13: EXPONENT POWER",
        content: `
            <h2>Base vs. Power</h2>
            <p><code>2³</code> is NOT <code>2 x 3</code>.</p>
            <p>It means the base (2) multiplies itself 3 times.</p>
            <p><code>2 x 2 x 2 = 8</code></p>
            <div class="tip-box">
                <b>TRICK:</b> Anything to the power of 0 (<code>N⁰</code>) is ALWAYS <b>1</b>.
            </div>
        `
    },
    {
        title: "CH 14: SCIENTIFIC NOTATION",
        content: `
            <h2>Handling Giants</h2>
            <p>For massive star distances, use powers of 10.</p>
            <p><code>5,000,000</code> = <code>5.0 x 10⁶</code></p>
            <p>Count the jumps the decimal makes to the left. That is your positive exponent.</p>
        `
    },
    {
        title: "CH 15: PRIME NUMBERS",
        content: `
            <h2>The Atoms of Logic</h2>
            <p>Prime numbers have exactly 2 factors: 1 and itself.</p>
            <p><b>Top Primes:</b> 2, 3, 5, 7, 11, 13, 17, 19, 23, 29...</p>
            <div class="tip-box">
                <b>FACT:</b> 1 is NOT a prime number. 2 is the ONLY even prime number.
            </div>
        `
    },
    {
        title: "CH 16: RATIO & PROPORTION",
        content: `
            <h2>The Scaling Effect</h2>
            <p>Used to find unknown fuel costs or travel times.</p>
            <p><code>2 : 5 = 4 : X</code></p>
            <p><b>TRICK:</b> Cross Multiply! <code>2 * X = 5 * 4</code>. <br><code>2x = 20</code>. <br><b>x = 10</b>.</p>
        `
    },
    {
        title: "CH 17: PYTHAGOREAN THEOREM",
        content: `
            <h2>The Triangle Truth</h2>
            <p>For Right Triangles: <code>a² + b² = c²</code></p>
            <p><b>TACTIC:</b> Memorize "Triples" to avoid squaring.</p>
            <ul>
                <li>3, 4, 5</li>
                <li>5, 12, 13</li>
                <li>8, 15, 17</li>
            </ul>
        `
    },
    {
        title: "CH 18: CARTESIAN PLANE",
        content: `
            <h2>The Targeting Grid</h2>
            <p><b>(X, Y) Coordinates:</b></p>
            <ul>
                <li><b>X:</b> Horizontal (Left/Right)</li>
                <li><b>Y:</b> Vertical (Up/Down)</li>
            </ul>
            <p>Quadrant 1: (+,+) | Quadrant 2: (-,+)</p>
            <p>Quadrant 3: (-,-) | Quadrant 4: (+,-)</p>
        `
    },
    {
        title: "CH 19: LINEAR EQUATIONS",
        content: `
            <h2>The Path of the Laser</h2>
            <p><code>y = mx + b</code></p>
            <ul>
                <li><b>m:</b> The Slope (Steepness)</li>
                <li><b>b:</b> The Y-intercept (Starting point)</li>
            </ul>
            <p>If <b>m</b> is positive, the line goes UP. If negative, it goes DOWN.</p>
        `
    },
    {
        title: "CH 20: RADICALS (ROOTS)",
        content: `
            <h2>Undoing the Square</h2>
            <p><code>√81</code> asks: "What number multiplied by itself is 81?"</p>
            <p>Answer: <b>9</b>.</p>
            <br>
            <h2>Approximation Trick</h2>
            <p><code>√50</code> is between <code>√49</code> (7) and <code>√64</code> (8). It is roughly <b>7.1</b>.</p>
        `
    },
    {
        title: "CH 21: POLYNOMIALS",
        content: `
            <h2>Many Names</h2>
            <p>Algebraic expressions with many terms.</p>
            <ul>
                <li><b>Monomial:</b> <code>3x</code></li>
                <li><b>Binomial:</b> <code>2x + 5</code></li>
                <li><b>Trinomial:</b> <code>x² + 4x + 4</code></li>
            </ul>
            <p>The "Degree" is the highest exponent.</p>
        `
    },
    {
        title: "CH 22: THE FOIL METHOD",
        content: `
            <h2>Multiplying Binomials</h2>
            <p><code>(x + 2)(x + 3)</code></p>
            <ul>
                <li><b>F</b>irst: <code>x * x = x²</code></li>
                <li><b>O</b>uter: <code>x * 3 = 3x</code></li>
                <li><b>I</b>nner: <code>2 * x = 2x</code></li>
                <li><b>L</b>ast: <code>2 * 3 = 6</code></li>
            </ul>
            <p>Total: <b>x² + 5x + 6</b>.</p>
        `
    },
    {
        title: "CH 23: FACTORING",
        content: `
            <h2>Breaking the Code</h2>
            <p>The opposite of FOIL. Finding what was multiplied.</p>
            <p><code>x² - 9</code></p>
            <p>This is the <b>Difference of Two Squares</b>.</p>
            <p>Answer: <b>(x + 3)(x - 3)</b>.</p>
        `
    },
    {
        title: "CH 24: PROBABILITY",
        content: `
            <h2>Calculating Fate</h2>
            <p>Probability = (Favorable) / (Total)</p>
            <p>A coin flip is <code>1/2</code> or <b>50%</b>.</p>
            <p>Probability is always between 0 (Impossible) and 1 (Certain).</p>
        `
    },
    {
        title: "CH 25: STATISTICS (MEAN)",
        content: `
            <h2>Finding the Middle</h2>
            <p><b>Mean:</b> The average. Add all and divide by how many.</p>
            <p>Data: 10, 20, 30. <br>Sum: 60. <br>Divide by 3: <b>20</b>.</p>
        `
    },
    {
        title: "CH 26: MEDIAN & MODE",
        content: `
            <h2>Data Analysis</h2>
            <p><b>Median:</b> The true middle when sorted from smallest to largest.</p>
            <p><b>Mode:</b> The number that appears the most often.</p>
            <p>Data: 2, 4, 4, 7, 9. <br>Mode: <b>4</b>. <br>Median: <b>4</b>.</p>
        `
    },
    {
        title: "CH 27: CIRCLE GEOMETRY",
        content: `
            <h2>The Constant Pi (π)</h2>
            <p><b>Circumference:</b> <code>2πr</code></p>
            <p><b>Area:</b> <code>πr²</code></p>
            <p>π is roughly <b>3.14</b>. It is the ratio of circumference to diameter.</p>
        `
    },
    {
        title: "CH 28: VOLUME",
        content: `
            <h2>3D Space Occupancy</h2>
            <ul>
                <li><b>Cube:</b> side³</li>
                <li><b>Cylinder:</b> Area of base x height (<code>πr²h</code>)</li>
                <li><b>Rectangular Prism:</b> L x W x H</li>
            </ul>
        `
    },
    {
        title: "CH 29: PARALLEL LINES",
        content: `
            <h2>Never Touching</h2>
            <p>Parallel lines have the <b>SAME SLOPE</b>.</p>
            <p>If line A is <code>y = 2x + 1</code>, any parallel line will also start with <code>y = 2x...</code></p>
        `
    },
    {
        title: "CH 30: FINAL MANIFESTO",
        content: `
            <h2>The language of Reality</h2>
            <p>Mathematics is not a subject; it is the blueprint of everything you see. From the spiral of galaxies to the code in your ship's computer.</p>
            <p>By mastering these rules, you are not just passing a grade. You are becoming a <b>Guardian of Order</b>.</p>
            <br>
            <center><h2>END OF ARCHIVES</h2></center>
        `
    },
    // --- 🧬 GRADE 8-9 TRANSITION: ADVANCED PATTERNS ---
    {
        title: "CH 31: LINEAR INEQUALITIES",
        content: `
            <h2>The "Shaded" Zone</h2>
            <p>Unlike equations, inequalities use <code><</code>, <code>></code>, <code>≤</code>, and <code>≥</code>.</p>
            <p><b>TACTIC:</b> When you multiply or divide by a <b>NEGATIVE</b> number, you MUST flip the sign!</p>
            <p><code>-2x < 10</code> -> <code>x > -5</code></p>
        `
    },
    {
        title: "CH 32: SYSTEMS OF EQUATIONS",
        content: `
            <h2>Double Target Lock</h2>
            <p>Finding the intersection of two lines.</p>
            <ul>
                <li><b>Substitution:</b> Plug one into the other.</li>
                <li><b>Elimination:</b> Add or subtract to kill one variable.</li>
            </ul>
            <div class="tip-box">
                If the lines are parallel, there is NO solution. The target is a ghost.
            </div>
        `
    },
    {
        title: "CH 33: SLOPE FORMULA",
        content: `
            <h2>Rise over Run</h2>
            <p><code>m = (y₂ - y₁) / (x₂ - x₁)</code></p>
            <p>Slope is the "Steepness" of your laser's path.</p>
            <ul>
                <li><b>Horizontal:</b> Slope = 0</li>
                <li><b>Vertical:</b> Slope = Undefined</li>
            </ul>
        `
    },
    {
        title: "CH 34: MIDPOINT FORMULA",
        content: `
            <h2>Find the Center</h2>
            <p>To find the exact middle between two coordinate points:</p>
            <p><code>M = ( (x₁+x₂)/2 , (y₁+y₂)/2 )</code></p>
            <p>It is simply the average of the X and Y coordinates.</p>
        `
    },
    {
        title: "CH 35: DISTANCE FORMULA",
        content: `
            <h2>Scanner Range</h2>
            <p>To find the distance between two targets <code>d = √[(x₂-x₁)² + (y₂-y₁)²]</code>.</p>
            <div class="tip-box">
                💡 This is just the Pythagorean Theorem in disguise!
            </div>
        `
    },
    {
        title: "CH 36: SPECIAL PRODUCTS",
        content: `
            <h2>Square of a Binomial</h2>
            <p><code>(a + b)² = a² + 2ab + b²</code></p>
            <p>Don't forget the middle term (2ab)! It is the most common error in the field.</p>
        `
    },
    {
        title: "CH 37: SUM & DIFF OF CUBES",
        content: `
            <h2>High-Level Factoring</h2>
            <p><code>a³ + b³ = (a + b)(a² - ab + b²)</code></p>
            <p><code>a³ - b³ = (a - b)(a² + ab + b²)</code></p>
            <p>Remember the <b>SOAP</b> acronym for signs: <b>S</b>ame, <b>O</b>pposite, <b>A</b>lways <b>P</b>ositive.</p>
        `
    },
    {
        title: "CH 38: RADICAL EQUATIONS",
        content: `
            <h2>Freeing the Root</h2>
            <p>To solve <code>√x = 5</code>, you must square both sides.</p>
            <p><code>(√x)² = 5²</code> -> <b>x = 25</b>.</p>
            <div class="tip-box">
                <b>WARNING:</b> Always check for extraneous solutions!
            </div>
        `
    },
    {
        title: "CH 39: RATIONAL EXPONENTS",
        content: `
            <h2>The Bridge</h2>
            <p><code>x^(1/2)</code> is just <code>√x</code>.</p>
            <p>The denominator of the fraction is the "Index" of the root.</p>
            <p><code>8^(1/3)</code> = Cube root of 8 = <b>2</b>.</p>
        `
    },
    {
        title: "CH 40: QUADRATIC FORMULA",
        content: `
            <h2>The Final Weapon</h2>
            <p>When you cannot factor, use this for <code>ax² + bx + c = 0</code>:</p>
            <p><code>x = [-b ± √(b² - 4ac)] / 2a</code></p>
            <p>The part <code>b² - 4ac</code> is called the <b>Discriminant</b>.</p>
        `
    },
    {
        title: "CH 41: CONGRUENT TRIANGLES",
        content: `
            <h2>Identical Units</h2>
            <p>Triangles are congruent if they have the same size and shape.</p>
            <ul>
                <li><b>SSS:</b> Side-Side-Side</li>
                <li><b>SAS:</b> Side-Angle-Side</li>
                <li><b>ASA:</b> Angle-Side-Angle</li>
            </ul>
        `
    },
    {
        title: "CH 42: SIMILAR TRIANGLES",
        content: `
            <h2>Scaled Models</h2>
            <p>Similar triangles have the same shape but different sizes. Their sides are <b>Proportional</b>.</p>
            <p>Use this to calculate the height of a building using its shadow.</p>
        `
    },
    {
        title: "CH 43: PARALLELOGRAMS",
        content: `
            <h2>Shield Geometry</h2>
            <ul>
                <li>Opposite sides are equal.</li>
                <li>Opposite angles are equal.</li>
                <li>Consecutive angles add up to 180°.</li>
            </ul>
        `
    },
    {
        title: "CH 44: THE UNIT CIRCLE",
        content: `
            <h2>Navigation Core</h2>
            <p>A circle with a radius of 1. Used to define <b>Sine</b> and <b>Cosine</b>.</p>
            <p>Degrees to Radians: Multiply by <code>π/180</code>.</p>
        `
    },
    {
        title: "CH 45: TRIGONOMETRY (SOH)",
        content: `
            <h2>The Hunter's Rule</h2>
            <p><b>SOH:</b> Sine = Opposite / Hypotenuse</p>
            <p><b>CAH:</b> Cosine = Adjacent / Hypotenuse</p>
            <p><b>TOA:</b> Tangent = Opposite / Adjacent</p>
        `
    },
    {
        title: "CH 46: LAW OF SINES",
        content: `
            <h2>Non-Right Triangles</h2>
            <p><code>a/sinA = b/sinB = c/sinC</code></p>
            <p>Use this when you know two angles and one side of any triangle.</p>
        `
    },
    {
        title: "CH 47: LAW OF COSINES",
        content: `
            <h2>Deep Space Tracking</h2>
            <p><code>c² = a² + b² - 2ab cosC</code></p>
            <p>Use this when you know two sides and the angle between them.</p>
        `
    },
    {
        title: "CH 48: PROBABILITY (AND/OR)",
        content: `
            <h2>Multiple Events</h2>
            <p><b>AND:</b> Multiply probabilities (<code>P(A) * P(B)</code>).</p>
            <p><b>OR:</b> Add probabilities (<code>P(A) + P(B)</code>).</p>
        `
    },
    {
        title: "CH 49: PERMUTATIONS",
        content: `
            <h2>Order Matters</h2>
            <p>How many ways to arrange 3 pilots in 3 ships?</p>
            <p><code>3! (Factorial) = 3 x 2 x 1 = 6</code>.</p>
        `
    },
    {
        title: "CH 50: COMBINATIONS",
        content: `
            <h2>Order Doesn't Matter</h2>
            <p>Choosing a team of 2 from 4 agents.</p>
            <p>Unlike permutations, picking Agent A then B is the same as B then A.</p>
        `
    },
    {
        title: "CH 51: LOGARITHMS",
        content: `
            <h2>Inverse of Power</h2>
            <p><code>log₂ 8 = 3</code> asks: "2 raised to what power is 8?"</p>
            <p>Answer: <b>3</b>.</p>
        `
    },
    {
        title: "CH 52: VARIATION (DIRECT)",
        content: `
            <h2>Linear Growth</h2>
            <p><code>y = kx</code></p>
            <p>As X increases, Y increases. (e.g., more speed = more fuel used).</p>
        `
    },
    {
        title: "CH 53: VARIATION (INVERSE)",
        content: `
            <h2>Balanced Force</h2>
            <p><code>y = k/x</code></p>
            <p>As X increases, Y decreases. (e.g., more agents = less time to finish a task).</p>
        `
    },
    {
        title: "CH 54: CIRCLE CHORDS",
        content: `
            <h2>Intersecting Lines</h2>
            <p>If two chords intersect inside a circle, the product of their segments are equal.</p>
            <p><code>(Segment A1 * A2) = (Segment B1 * B2)</code></p>
        `
    },
    {
        title: "CH 55: TANGENT LINES",
        content: `
            <h2>The 90-Degree Touch</h2>
            <p>A tangent line touches a circle at exactly one point and is ALWAYS perpendicular to the radius.</p>
        `
    },
    {
        title: "CH 56: ARCS AND ANGLES",
        content: `
            <h2>The Inscribed Rule</h2>
            <p>An inscribed angle is <b>HALF</b> the measure of its intercepted arc.</p>
        `
    },
    {
        title: "CH 57: COMPLEX NUMBERS",
        content: `
            <h2>The Imaginary Unit (i)</h2>
            <p><code>i = √-1</code></p>
            <p><code>i² = -1</code></p>
            <p>Standard form: <code>a + bi</code></p>
        `
    },
    {
        title: "CH 58: RADICAL DENOMINATORS",
        content: `
            <h2>Rationalizing</h2>
            <p>Do not leave a square root in the bottom! Multiply top and bottom by the root to "clean" it.</p>
        `
    },
    {
        title: "CH 59: PARABOLA FOCUS",
        content: `
            <h2>Satellite Trajectory</h2>
            <p>The graph of a quadratic equation. The "Vertex" is the turning point.</p>
        `
    },
    {
        title: "CH 60: CONIC SECTIONS",
        content: `
            <h2>Orbital Mechanics</h2>
            <p>The four shapes made by cutting a cone:</p>
            <ol>
                <li>Circle</li>
                <li>Ellipse</li>
                <li>Parabola</li>
                <li>Hyperbola</li>
            </ol>
        `
    },
    // --- 🚀 ADVANCED MASTERY: GRADE 9 & BEYOND ---
    {
        title: "CH 61: QUADRATIC FUNCTIONS",
        content: `
            <h2>The Curve of Fate</h2>
            <p>Form: <code>f(x) = ax² + bx + c</code>.</p>
            <p>The graph is a <b>Parabola</b>. If 'a' is positive, it opens up (Happy). If negative, it opens down (Sad).</p>
        `
    },
    {
        title: "CH 62: THE VERTEX",
        content: `
            <h2>The Turning Point</h2>
            <p>To find the peak or bottom of a parabola: <code>x = -b / 2a</code>.</p>
            <p>Use this to calculate the maximum height of a projectile fired from your turret.</p>
        `
    },
    {
        title: "CH 63: DISCRIMINANT SCAN",
        content: `
            <h2>Analyzing Roots</h2>
            <p>Using <code>D = b² - 4ac</code>:</p>
            <ul>
                <li><b>D > 0:</b> Two real solutions.</li>
                <li><b>D = 0:</b> One real solution.</li>
                <li><b>D < 0:</b> No real solutions (Imaginary).</li>
            </ul>
        `
    },
    {
        title: "CH 64: RADICAL REFINEMENT",
        content: `
            <h2>Simplifying Roots</h2>
            <p><code>√50</code> -> Think: <code>√(25 x 2)</code>.</p>
            <p>Since √25 is 5, the answer is <b>5√2</b>.</p>
            <div class="tip-box">Always look for perfect square factors inside the root!</div>
        `
    },
    {
        title: "CH 65: VARIATION (JOINT)",
        content: `
            <h2>Combined Forces</h2>
            <p><code>y = kxz</code></p>
            <p>Y varies directly with the product of X and Z. (e.g., Damage depends on both Power and Accuracy).</p>
        `
    },
    {
        title: "CH 66: VARIATION (COMBINED)",
        content: `
            <h2>Complex Ratios</h2>
            <p><code>y = kx / z</code></p>
            <p>Directly with X and inversely with Z. This is how engine efficiency is calculated.</p>
        `
    },
    {
        title: "CH 67: CIRCLE SEGMENTS",
        content: `
            <h2>Secant-Secant Rule</h2>
            <p>When two secants intersect outside: <code>(Whole1 x Outside1) = (Whole2 x Outside2)</code>.</p>
        `
    },
    {
        title: "CH 68: TANGENT-SECANT",
        content: `
            <h2>The Intersection Rule</h2>
            <p><code>(Tangent)² = (Whole Secant x Outside Part)</code>.</p>
            <p>Use this for calculating glancing blows on enemy shields.</p>
        `
    },
    {
        title: "CH 69: TRIGONOMETRY (RECIPROCALS)",
        content: `
            <h2>The Flip Side</h2>
            <ul>
                <li><b>Cosecant (csc):</b> 1/sin</li>
                <li><b>Secant (sec):</b> 1/cos</li>
                <li><b>Cotangent (cot):</b> 1/tan</li>
            </ul>
        `
    },
    {
        title: "CH 70: PYTHAGOREAN ID",
        content: `
            <h2>The Master Identity</h2>
            <p style="font-size: 24px; text-align:center;"><b>sin²θ + cos²θ = 1</b></p>
            <p>This law holds true for any angle in the digital universe.</p>
        `
    },
    {
        title: "CH 71: ANGLE OF ELEVATION",
        content: `
            <h2>Targeting Upward</h2>
            <p>The angle from the horizontal line of sight looking up at a target. Use <b>Tangent</b> to find the height.</p>
        `
    },
    {
        title: "CH 72: ANGLE OF DEPRESSION",
        content: `
            <h2>Targeting Downward</h2>
            <p>The angle looking down from a high vantage point. Remember: Angle of Elevation = Angle of Depression (Alternate Interior).</p>
        `
    },
    {
        title: "CH 73: ARC LENGTH",
        content: `
            <h2>Measuring the Curve</h2>
            <p><code>s = rθ</code> (where θ is in radians).</p>
            <p>If θ is in degrees: <code>(Degrees/360) x 2πr</code>.</p>
        `
    },
    {
        title: "CH 74: SECTOR AREA",
        content: `
            <h2>Slicing the Circle</h2>
            <p>Area = <code>(Degrees/360) x πr²</code>.</p>
            <p>Use this to calculate the coverage area of your EMP blast.</p>
        `
    },
    {
        title: "CH 75: MIDRANGE",
        content: `
            <h2>Quick Average</h2>
            <p>Midrange = <code>(Highest + Lowest) / 2</code>.</p>
            <p>A fast way to estimate the center of a data set during combat.</p>
        `
    },
    {
        title: "CH 76: PROBABILITY (NOT)",
        content: `
            <h2>Complementary Events</h2>
            <p><code>P(Not A) = 1 - P(A)</code>.</p>
            <p>If there is a 20% chance to miss, there is an 80% chance to hit.</p>
        `
    },
    {
        title: "CH 77: FACTORIALS (!)",
        content: `
            <h2>Counting Chaos</h2>
            <p><code>5! = 5 x 4 x 3 x 2 x 1 = 120</code>.</p>
            <p>Used to find the number of ways to arrange unique items.</p>
        `
    },
    {
        title: "CH 78: PERCENT INCREASE",
        content: `
            <h2>Economic Growth</h2>
            <p><code>[(New - Old) / Old] x 100</code>.</p>
            <p>Use this to track your score growth round-by-round.</p>
        `
    },
    {
        title: "CH 79: SIMPLE INTEREST",
        content: `
            <h2>Banking for Base</h2>
            <p><code>I = Prt</code></p>
            <ul>
                <li><b>P:</b> Principal (Starting Coins)</li>
                <li><b>r:</b> Rate</li>
                <li><b>t:</b> Time</li>
            </ul>
        `
    },
    {
        title: "CH 80: COMPOUND INTEREST",
        content: `
            <h2>The Power of Time</h2>
            <p><code>A = P(1 + r/n)^(nt)</code>.</p>
            <p>Interest that earns interest. The secret to long-term galactic wealth.</p>
        `
    },
    {
        title: "CH 81: SET THEORY",
        content: `
            <h2>Grouping Logic</h2>
            <ul>
                <li><b>Union (∪):</b> Everything in both sets.</li>
                <li><b>Intersection (∩):</b> Only what is shared.</li>
            </ul>
        `
    },
    {
        title: "CH 82: VENN DIAGRAMS",
        content: `
            <h2>Visualizing Logic</h2>
            <p>Overlapping circles used to show relationships between different sets of Nullifier types.</p>
        `
    },
    {
        title: "CH 83: ABSOLUTE VALUE",
        content: `
            <h2>Magnitude Only</h2>
            <p><code>|-5| = 5</code>. Distance from zero regardless of direction.</p>
            <p>Damage is always positive, even if it comes from a negative direction.</p>
        `
    },
    {
        title: "CH 84: FUNCTION NOTATION",
        content: `
            <h2>The Machine</h2>
            <p><code>f(x)</code> is just a fancy way of saying <b>Y</b>.</p>
            <p>Input <b>X</b>, apply the rule, get output <b>Y</b>.</p>
        `
    },
    {
        title: "CH 85: DOMAIN & RANGE",
        content: `
            <h2>The Input/Output Map</h2>
            <ul>
                <li><b>Domain:</b> All possible X values (Inputs).</li>
                <li><b>Range:</b> All possible Y values (Outputs).</li>
            </ul>
        `
    },
    {
        title: "CH 86: SLOPE-INTERCEPT",
        content: `
            <h2>Graphing Fast</h2>
            <p><code>y = mx + b</code>.</p>
            <p>Start at 'b' on the Y-axis, then move 'm' (Rise/Run) to find the next point.</p>
        `
    },
    {
        title: "CH 87: POINT-SLOPE FORM",
        content: `
            <h2>Targeting from a Point</h2>
            <p><code>y - y₁ = m(x - x₁)</code>.</p>
            <p>Useful when you know the slope and only one point on the line.</p>
        `
    },
    {
        title: "CH 88: STANDARD FORM",
        content: `
            <h2>Unified Equation</h2>
            <p><code>Ax + By = C</code>.</p>
            <p>To find intercepts: Set x=0 to find Y, and set y=0 to find X.</p>
        `
    },
    {
        title: "CH 89: MEAN ABSOLUTE DEV",
        content: `
            <h2>Consistency Check</h2>
            <p>MAD measures how spread out your data is. A low MAD means your firing accuracy is consistent.</p>
        `
    },
    {
        title: "CH 90: CORRELATION",
        content: `
            <h2>Trend Analysis</h2>
            <p>Does increasing Power increase Speed? If both go up, it is a <b>Positive Correlation</b>.</p>
        `
    },
    {
        title: "CH 91: RADICAL CONJUGATES",
        content: `
            <h2>Cleaning Fractions</h2>
            <p>To remove <code>(1 / 1+√2)</code>, multiply by <code>(1-√2)</code>. This is the <b>Conjugate</b>.</p>
        `
    },
    {
        title: "CH 92: RATIONAL EQUATIONS",
        content: `
            <h2>Fractional Locks</h2>
            <p>Multiply the entire equation by the <b>LCD</b> to "kill" the denominators and solve normally.</p>
        `
    },
    {
        title: "CH 93: SURFACE AREA",
        content: `
            <h2>Shield Surface</h2>
            <ul>
                <li><b>Sphere:</b> 4πr²</li>
                <li><b>Cylinder:</b> 2πr² + 2πrh</li>
            </ul>
        `
    },
    {
        title: "CH 94: TRUTH TABLES",
        content: `
            <h2>Pure Logic</h2>
            <p>Analyzing T/F values. Used to debug your ship's AI and predictive targeting.</p>
        `
    },
    {
        title: "CH 95: LIMITS (CALCULUS)",
        content: `
            <h2>Approaching Infinity</h2>
            <p>What happens to a value as it gets closer and closer to a point without actually reaching it?</p>
        `
    },
    {
        title: "CH 96: DERIVATIVES",
        content: `
            <h2>Instantaneous Change</h2>
            <p>The exact slope at a single point on a curve. This is how we track accelerating enemies.</p>
        `
    },
    {
        title: "CH 97: INTEGRALS",
        content: `
            <h2>Area Under Curve</h2>
            <p>The total accumulation. Used to calculate total energy consumed during a mission.</p>
        `
    },
    {
        title: "CH 98: THE GOLDEN RATIO (φ)",
        content: `
            <h2>Divine Proportion</h2>
            <p>φ ≈ 1.618. Found in snail shells, galaxies, and human faces. The math of beauty.</p>
        `
    },
    {
        title: "CH 99: QUANTUM MATH",
        content: `
            <h2>Beyond the Basics</h2>
            <p>Where numbers can be in two states at once. The final frontier of the N.E.X.U.S. project.</p>
        `
    },
    {
        title: "CH 100: THE INFINITE",
        content: `
            <h2>The Journey's End</h2>
            <p>Mathematics is a never-ending ladder. There is always a larger number, a deeper theorem, and a new mystery.</p>
            <p>You are now a <b>Master of Logic</b>. Use this power to protect our world.</p>
            <br>
            <center><h1>MISSION COMPLETE</h1></center>
        `
    },
    {
        // 🚨 AUTHOR PAGE / BACK COVER DESIGN 🚨
        title: "", 
        content: `
            <div class="back-cover-content">
                <h3 style="font-family: 'Orbitron'; letter-spacing: 5px;">SYSTEM ARCHITECT</h3>
                
                <h1 style="font-size: 45px; border:none; margin: 20px 0;">JESSTER R.<br>GIRADO</h1>
                
                <div class="gold-divider"></div>
                
                <p style="font-weight: bold; color: #ffd700;">LEAD DEVELOPER & AUTHOR</p>
                
                <br><br>
                <img src="https://img.icons8.com/ios-filled/100/ffd700/quill-pen.png" style="width: 60px; opacity: 0.9;">
                
                <br><br>
                <p style="font-size: 14px; opacity: 0.7; font-family: 'Courier New';">
                    MATH DEFENDER PROJECT © 2026<br>
                    ALL RIGHTS RESERVED<br>
                    MANILA COMMAND CENTER
                </p>
            </div>
        `
    }
];

// 3. BOOK LOGIC (STATE MANAGEMENT)
let currentLocation = 1; // 1 = Cover
let numOfPapers = 0;
let maxLocation = 0;

window.openCodex = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("start-modal").classList.add("hidden");
    document.getElementById("codex-modal").classList.remove("hidden");
    
    // Initialize Book
    initBook();
};

window.closeCodex = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("codex-modal").classList.add("hidden");
    if(!state.isPlaying) {
        document.getElementById("start-modal").classList.remove("hidden");
    }
};

function initBook() {
    const bookContainer = document.getElementById("book");
    bookContainer.innerHTML = ""; // Clear existing DOM

    // 1. SETUP FRONT COVER (This is 'p1')
    const cover = document.createElement("div");
    cover.className = "paper";
    cover.id = "p1";
    // Cover is always on top (Highest Z-Index)
    cover.style.zIndex = codexData.length + 2; 
    
    cover.innerHTML = `
        <div class="front cover-front">
            <div class="cover-design">
                <h1>MATH<br>DEFENDER</h1>
                <p>TACTICAL MANUAL</p>
                <br><small style="color:#d4af37; font-family:'Orbitron';">TAP 'NEXT' TO ACCESS</small>
            </div>
        </div>
        <div class="back cover-back">
            <div class="page-content" style="color: #d4af37; text-align: center; padding-top: 50%;">
                <h3>PROPERTY OF:</h3>
                <h1 style="font-family:'Courier New'; border:none;">COMMANDER</h1>
                <p>TOP SECRET CLEARANCE</p>
            </div>
        </div>
    `;
    bookContainer.appendChild(cover);

    // 2. SETUP CONTENT PAGES
    codexData.forEach((data, index) => {
        const i = index + 1; // Paper index (1-based because cover is 0 in logic, but here we treat cover as separate)
        const pageID = index + 2; // DOM ID starts at p2

        const paper = document.createElement("div");
        paper.className = "paper generated-page";
        paper.id = `p${pageID}`;
        
        // Z-Index Stack Order
        paper.style.zIndex = codexData.length - index; 

        // Front Content (Laging Lesson Content)
        const front = document.createElement("div");
        front.className = "front";
        front.innerHTML = `
            <div class="page-content">
                ${data.title ? `<h1>${data.title}</h1>` : ''}
                ${data.content}
                <div class="page-num">${index * 2 + 1}</div>
            </div>`;

        // Back Content Logic (DITO ANG PAGBABAGO)
        const back = document.createElement("div");
        back.className = "back";

        // 🚨 CHECK IF LAST PAGE: Kung ito na ang huling data, ang likod nito ay BACK COVER na.
        if (index === codexData.length - 1) {
            back.innerHTML = `
                <div class="back-cover-content">
                    <h3>SYSTEM ARCHITECT</h3>
                    <h1>JESSTER R.<br>GIRADO</h1>
                    <div class="gold-divider"></div>
                    <p>LEAD DEVELOPER & AUTHOR</p>
                    <br>
                    <p style="font-size: 12px; opacity: 0.6;">
                        MATH DEFENDER PROJECT © 2026<br>
                        ALL RIGHTS RESERVED
                    </p>
                </div>`;
        } else {
            // Kung hindi pa huli, "NOTES" page lang ang likod
            back.innerHTML = `
                <div class="page-content">
                    <center><h2 style="opacity:0.3; margin-top:50%;">NOTES</h2></center>
                    <div style="font-family:'Courier New'; color:#554433; text-align:center; font-size:14px; opacity:0.6;">
                        <i>[ This page intentionally left blank for tactical calculations ]</i>
                    </div>
                    <div class="page-num">${index * 2 + 2}</div>
                </div>`;
        }

        paper.appendChild(front);
        paper.appendChild(back);
        
        // Append to book container
        bookContainer.appendChild(paper);
    });

    // Reset State
    currentLocation = 1;
    numOfPapers = codexData.length + 1; // Content + Cover
    maxLocation = numOfPapers + 1;
    
    // Ensure book is centered
    document.getElementById("book").classList.remove("opened");
}

window.nextPage = function() {
    if (currentLocation < maxLocation) {
        if(window.Sound) window.playPageTurnSound(); 

        const paper = document.getElementById("p" + currentLocation);
        if(paper) {
            paper.classList.add("flipped");
            paper.style.zIndex = currentLocation; // Move to bottom of left stack
        }

        // Open animation (Shift book to center of screen)
        if (currentLocation === 1) {
            document.getElementById("book").classList.add("opened");
        }
        
        currentLocation++;
    }
};

window.prevPage = function() {
    if (currentLocation > 1) {
        if(window.Sound) window.playPageTurnSound();

        currentLocation--;
        
        const paper = document.getElementById("p" + currentLocation);
        if(paper) {
            paper.classList.remove("flipped");
            
            // Delay Z-Index change to allow animation to finish showing on top
            setTimeout(() => {
                // Ensure it goes back to correct stack height
                paper.style.zIndex = numOfPapers - currentLocation + 2; 
            }, 300);
        }

        // Close animation (If back at cover)
        if (currentLocation === 1) {
            document.getElementById("book").classList.remove("opened");
        }
    }
};

// Keyboard Shortcuts for Book
document.addEventListener("keydown", function(event) {
    const codex = document.getElementById('codex-modal');
    if (codex && !codex.classList.contains('hidden')) {
        if (event.key === "ArrowRight" || event.key === "d") window.nextPage();
        if (event.key === "ArrowLeft" || event.key === "a") window.prevPage();
        if (event.key === "Escape") window.closeCodex();
    }
});

// ==========================================
// 📊 AGENT SERVICE RECORD & ANALYTICS LOGIC
// ==========================================

let perfChart = null; // Store chart instance

// 1. OPEN DASHBOARD (WITH LIVE DATA FETCH)
window.openAgentDashboard = async function() {
    if (!currentUser) return alert("Please Login First.");
    if(window.Sound) window.Sound.click();

    // Show Loading State (Optional visual cue)
    const dashModal = document.getElementById("agent-dashboard-modal");
    if (!dashModal) return alert("Dashboard Modal Missing in HTML!");
    
    // Hide Main Menus
    document.getElementById("start-modal").classList.add("hidden");
    
    // Show Dashboard
    dashModal.classList.remove("hidden");
    dashModal.style.display = 'flex'; 

    try {
        // 🟢 FORCE FETCH: Kunin ang pinakabagong data sa database
        const docRef = doc(db, "users", currentUser.uid);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            // Merge bago at lumang data
            currentUser = { ...currentUser, ...docSnap.data() };
            console.log("📥 Latest Data Loaded:", currentUser.matchHistory);
        }

        // Set Basic Info
        document.getElementById("dash-agent-name").innerText = currentUser.username || "AGENT";
        document.getElementById("dash-rank").innerText = getRankInfo(currentUser.totalXP || 0).title;
        
        let currentAvatar = currentUser.avatar || 'https://img.icons8.com/color/96/000000/astronaut.png';
        document.getElementById("dash-avatar-img").src = currentAvatar;

        // Render contents
        if(window.renderBadges) window.renderBadges();
        
        // Draw Chart (Update UI)
        setTimeout(() => {
            if(window.updateDashboardChart) window.updateDashboardChart(); 
        }, 100);

    } catch (error) {
        console.error("Dashboard Error:", error);
    }
};

window.closeAgentDashboard = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("agent-dashboard-modal").classList.add("hidden");
    
    // Ibalik ang main menus
    document.getElementById("start-modal").classList.remove("hidden");
    document.getElementById("profile-section").classList.remove("hidden");
};

// 2. AVATAR SYSTEM
window.toggleAvatarSelect = function() {
    const box = document.getElementById("avatar-selection-box");
    box.classList.toggle("hidden");
    
    if (!box.classList.contains("hidden")) {
        // Mga pagpipiliang Profile Pictures (Sci-Fi Icons)
        const avatars = [
            "https://img.icons8.com/color/96/000000/astronaut.png",
            "https://img.icons8.com/color/96/000000/bot.png",
            "https://img.icons8.com/color/96/000000/hacker.png",
            "https://img.icons8.com/color/96/000000/ninja-head.png",
            "https://img.icons8.com/external-flaticons-flat-flat-icons/64/000000/external-alien-space-flaticons-flat-flat-icons.png",
            "https://img.icons8.com/color/96/000000/iron-man.png"
        ];
        
        let html = "";
        avatars.forEach(url => {
            html += `<img src="${url}" class="avatar-option" style="width:50px; height:50px; background:#222; border-radius:5px;" onclick="selectAvatar('${url}')">`;
        });
        document.getElementById("avatar-grid").innerHTML = html;
    }
};

window.selectAvatar = async function(url) {
    if(window.Sound) window.Sound.click();
    document.getElementById("dash-avatar-img").src = url;
    document.getElementById("avatar-selection-box").classList.add("hidden");
    
    currentUser.avatar = url;
    await updateDoc(doc(db, "users", currentUser.uid), { avatar: url });
};

// 3. BADGES SYSTEM (Dummy logic for now)
function renderBadges() {
    const grid = document.getElementById("badges-grid");
    const unlocked = currentUser.badges || [];
    
    const allBadges = [
        { id: 'first_blood', icon: '🩸', title: 'First Mission' },
        { id: 'combo_10', icon: '🔥', title: '10x Combo' },
        { id: 'boss_slayer', icon: '☠️', title: 'Boss Defeated' },
        { id: 'accuracy_90', icon: '🎯', title: 'Sharpshooter' }
    ];

    let html = "";
    allBadges.forEach(b => {
        let isHas = unlocked.includes(b.id);
        html += `<div class="badge-icon ${isHas ? 'unlocked' : ''}" title="${b.title}">${b.icon}</div>`;
    });
    grid.innerHTML = html;
}

// 4. CHART.JS & TABLE RENDERER (ROBUST VERSION)
window.updateDashboardChart = function() {
    // Safety check for user data
    const history = (currentUser && currentUser.matchHistory) ? currentUser.matchHistory : [];
    
    // Safety check for UI elements (Avoid crash if modal is closed)
    const chartFilter = document.getElementById("chart-filter");
    const topicFilter = document.getElementById("topic-filter");
    const tbody = document.getElementById("match-history-body");
    const canvas = document.getElementById('performanceChart');

    if (!chartFilter || !topicFilter || !tbody || !canvas) return;

    const modeFilter = chartFilter.value;
    const topicFilterVal = topicFilter.value;

    // Filter Logic
    let filteredData = history.filter(match => {
        let modeMatch = modeFilter === 'all' || match.mode === modeFilter;
        let topicMatch = topicFilterVal === 'all' || (match.ops && match.ops.includes(topicFilterVal));
        return modeMatch && topicMatch;
    });

    // Populate Table
    tbody.innerHTML = "";
    
    if (filteredData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="padding: 30px; color: #666; font-style: italic; border-bottom: 1px solid #333;">NO COMBAT RECORDS FOUND.</td></tr>`;
    } else {
        // Reverse para latest ang nasa taas
        filteredData.slice().reverse().forEach(match => {
            let dateObj = new Date(match.date);
            let dateStr = dateObj.toLocaleDateString() + " " + dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            let accColor = match.accuracy >= 80 ? '#00ff41' : (match.accuracy >= 50 ? '#ffd700' : '#ff0055');
            let opsStr = match.ops ? match.ops.join(' ') : 'Mixed';
            
            tbody.innerHTML += `
                <tr style="border-bottom: 1px solid #222;">
                    <td style="color: #ccc; padding: 10px;">${dateStr}</td>
                    <td style="color: #00e5ff; font-weight: bold; padding: 10px;">${match.mode.toUpperCase()}</td>
                    <td style="color: #aaa; padding: 10px;">[ ${opsStr} ]</td>
                    <td style="color: #ffd700; font-family: 'Orbitron'; padding: 10px;">${match.score}</td>
                    <td style="color: ${accColor}; font-weight: bold; padding: 10px;">${match.accuracy}%</td>
                </tr>
            `;
        });
    }

    // Chart Logic
    if (typeof Chart === 'undefined') return;
    
    const ctx = canvas.getContext('2d');
    if (perfChart) perfChart.destroy();

    // Default Empty State (Flat Line)
    let labels = ['Start'];
    let accData = [0];
    let scoreData = [0];

    if (filteredData.length > 0) {
        labels = filteredData.map((m, i) => `M${i+1}`);
        accData = filteredData.map(m => m.accuracy);
        scoreData = filteredData.map(m => m.score);
    }

    perfChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Accuracy (%)',
                    data: accData,
                    borderColor: '#00ff41',
                    backgroundColor: 'rgba(0, 255, 65, 0.1)',
                    yAxisID: 'y',
                    tension: 0.3,
                    fill: true,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: 'Score',
                    data: scoreData,
                    borderColor: '#ffd700',
                    borderDash: [5, 5],
                    yAxisID: 'y1',
                    tension: 0.3,
                    pointRadius: 4,
                    pointHoverRadius: 6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: { 
                    type: 'linear', display: true, position: 'left', min: 0, max: 100, 
                    title: { display: true, text: 'Accuracy', color: '#00ff41' },
                    grid: { color: '#222' }, ticks: { color: '#888' }
                },
                y1: { 
                    type: 'linear', display: true, position: 'right', 
                    title: { display: true, text: 'Score', color: '#ffd700' },
                    grid: { drawOnChartArea: false }, ticks: { color: '#888' } 
                },
                x: { 
                    grid: { color: '#222' }, ticks: { color: '#888' } 
                }
            },
            plugins: {
                legend: { labels: { color: '#fff', font: { family: 'Rajdhani', size: 12 } } }
            }
        }
    });
};

// 5. 🟢 CRITICAL: ROBUST SAVE FUNCTION (FIXED MATH)
window.saveMatchRecord = async function() {
    if (!currentUser || !currentUser.uid) {
        console.warn("⚠️ Cannot save: No user logged in.");
        return;
    }

    // Prevent saving empty spam games
    if (state.score === 0 && state.gameHistory.length === 0) {
        return; 
    }

    console.log("💾 SAVING MISSION DATA...");

    // 🟢 BETTER MATH FOR ACCURACY
    // Bilangin ang totoong tama at mali base sa history log
    let correctCount = state.gameHistory.filter(h => h.status === 'correct').length;
    let totalAttempts = state.gameHistory.length;
    
    let finalAcc = 0;
    if (totalAttempts > 0) {
        finalAcc = Math.round((correctCount / totalAttempts) * 100);
    }
    
    // Fallback: Kung walang history pero may score (edge case)
    if (totalAttempts === 0 && state.score > 0) finalAcc = 100;

    let matchRecord = {
        date: Date.now(),
        mode: state.gameMode || 'solo',
        ops: state.selectedOps || ['+'],
        difficulty: state.difficulty || 'medium',
        score: state.score,
        accuracy: finalAcc
    };

    // Update Local History
    let history = (currentUser.matchHistory) ? [...currentUser.matchHistory] : [];
    history.push(matchRecord);
    
    // Limit to last 50 games
    if (history.length > 50) {
        history = history.slice(history.length - 50); 
    }
    currentUser.matchHistory = history;

    // Save to Firebase
    try {
        const userRef = doc(db, "users", currentUser.uid);
        await updateDoc(userRef, {
            matchHistory: history,
            coins: state.coins, // Save money updates too
            lastActive: Date.now()
        });

        console.log("✅ RECORD SAVED! Acc:", finalAcc + "%");
        
        const btn = document.getElementById("real-submit-btn");
        if(btn) btn.innerText = "✅ DATA SECURED";

    } catch(e) { 
        console.error("❌ SAVE ERROR:", e);
        if (e.code === 'not-found') {
             await setDoc(doc(db, "users", currentUser.uid), { matchHistory: history, coins: state.coins }, { merge: true });
        }
    }
};

window.openLeaderboard = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("start-modal").classList.add("hidden");
    document.getElementById("leaderboard-modal").classList.remove("hidden");
    window.fetchLeaderboardData(); // Auto fetch upon opening
};
window.switchLbMode = function(mode, event) {
    if(window.Sound) window.Sound.click();
    window.currentLbMode = mode;
    document.querySelectorAll('.lb-mode-tabs .tab-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    window.fetchLeaderboardData();
};
window.switchLbOp = function(op, element) {
    if(window.Sound) window.Sound.click();
    window.currentLbOp = op;
    document.querySelectorAll('.lb-filter-btn').forEach(btn => btn.classList.remove('active'));
    element.classList.add('active');
    window.fetchLeaderboardData();
};

window.closeLeaderboard = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("leaderboard-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.remove("hidden");
};


window.fetchLeaderboardData = async function() {
    document.getElementById("lb-dynamic-title").innerText = `GLOBAL RANKINGS: ${window.currentLbMode.toUpperCase()} // ${window.currentLbOp.toUpperCase()}`;
    
    const listBody = document.getElementById("lb-table-body");
    const podiumBox = document.getElementById("lb-podium-container");
    
    listBody.innerHTML = "<tr><td colspan='3' style='text-align:center; padding:30px; color:#00e5ff;' class='blink'>Scanning Database...</td></tr>";
    podiumBox.innerHTML = "";

    try {
        if (!db) throw new Error("Firebase Offline");

        // ⚠️ REQUIRES FIREBASE COMPOSITE INDEX! (Check console if it fails)
        const q = query(
            collection(db, "scores"), 
            where("mode", "==", window.currentLbMode),
            where("operation", "==", window.currentLbOp),
            orderBy("score", "desc"), 
            limit(10)
        );
        
        const snap = await getDocs(q); 
        let results = [];
        snap.forEach(d => results.push(d.data()));

        if (results.length === 0) {
            listBody.innerHTML = "<tr><td colspan='3' style='text-align:center; padding:30px; color:#888;'>NO TACTICAL DATA FOUND FOR THIS CATEGORY.</td></tr>";
            return;
        }

        // 1. RENDER PODIUM (TOP 3)
        let top3 = results.slice(0, 3);
        const ranks = ['rank-1', 'rank-2', 'rank-3'];
        const emojis = ['👑', '🥈', '🥉'];
        const displayOrder = [1, 0, 2]; // Show 2nd, 1st, 3rd

        displayOrder.forEach(idx => {
            if(top3[idx]) {
                let p = top3[idx];
                podiumBox.innerHTML += `
                    <div class="podium-column ${ranks[idx]}">
                        <div class="podium-avatar" style="width:50px; height:50px; font-size:20px;">${emojis[idx]}</div>
                        <div class="podium-bar" style="height:${100 - (idx*20)}px; font-size: 24px;">
                            <span class="rank-num">${idx + 1}</span>
                        </div>
                        <div class="winner-name-tag">${p.name.substring(0, 8)}</div>
                        <div style="color:#ffd700; font-weight:bold; font-size:14px;">${p.score}</div>
                    </div>
                `;
            }
        });

        // 2. RENDER LIST (RANKS 4-10)
        listBody.innerHTML = "";
        for (let i = 3; i < results.length; i++) {
            let p = results[i];
            listBody.innerHTML += `
                <tr>
                    <td style="padding: 12px; text-align: center; color: #888; font-weight: bold;">${i + 1}</td>
                    <td style="padding: 12px; color: #fff;">${p.name}</td>
                    <td style="padding: 12px; text-align: right; color: #00e5ff; font-family: 'Orbitron'; font-weight: bold;">${p.score}</td>
                </tr>
            `;
        }

    } catch(e) {
        console.error("Leaderboard Query Failed:", e);
        listBody.innerHTML = `<tr><td colspan='3' style='text-align:center; padding:30px; color:#ff0055;'>
            DATABASE INDEXING REQUIRED. Check Console Log.
        </td></tr>`;
    }
};

function getOperationTag(opsArray) {
    if (!opsArray || opsArray.length === 0) return 'add';
    if (opsArray.length > 1) return 'mixed';
    let op = opsArray[0];
    if (op === '+') return 'add';
    if (op === '-') return 'sub';
    if (op === 'x') return 'mul';
    if (op === '÷') return 'div';
    if (op === 'Alg') return 'alg';
    return 'mixed';
}

window.submitScore = async function() {
    if(window.Sound) window.Sound.click();
    if(state.scoreSubmitted) return;
    
    // Anti-spam: Wag i-save kung 0 ang score
    if(state.score <= 0) {
        alert("COMMANDER: Score is too low to enter the Elite Database.");
        return;
    }

    const finalName = myName || "Agent";
    const btn = document.getElementById("real-submit-btn");
    if(btn) btn.innerText = "UPLOADING TO MAINFRAME...";

    let opTag = getOperationTag(state.selectedOps);

    try {
        await addDoc(collection(db, "scores"), {
            name: finalName,
            score: state.score,
            mode: state.gameMode || 'solo',
            operation: opTag,
            date: Date.now()
        });
        state.scoreSubmitted = true;
        if(btn) {
            btn.innerText = "✅ DATA SECURED";
            btn.style.color = "#00ff41";
            btn.style.borderColor = "#00ff41";
        }
    } catch(e) {
        alert("Upload Error. System Offline.");
        if(btn) btn.innerText = "❌ UPLOAD FAILED";
    }
};
// ==========================================
// PHASE 1 & 2: SOCIAL SYSTEM & ANALYTICS
// ==========================================

let radarChartInstance = null;
let isComparing = false;

// 1. Toggle the Slide-out Sidebar

window.toggleCommsSidebar = function() {
    if(window.Sound) window.Sound.click();
    const sidebar = document.getElementById("comms-sidebar");
    if(sidebar) sidebar.classList.toggle("closed");
    
    // 🟢 INSTANT HIDE/SHOW ANG ORB!
    if(window.updateOrbsVisibility) window.updateOrbsVisibility();
};

window.switchCommsTab = function(tabName, event) {
    if(window.Sound) window.Sound.click();
    
    // UI Update Tabs
    const tabs = document.querySelectorAll(".ts-tabs .ts-tab");
    tabs.forEach(t => t.classList.remove("active"));
    event.target.classList.add("active");

    // UI Update Content
    const views = document.querySelectorAll(".comms-view");
    views.forEach(v => v.classList.add("hidden"));
    document.getElementById("comms-" + tabName).classList.remove("hidden");
};
// 2. REAL DATABASE LIVE SEARCH (AUTO-COMPLETE)
let searchTimeout = null; // 🟢 Para sa Debouncing Technique

window.mockSearchAgent = async function() { 
    const searchInput = document.getElementById("agent-search-input").value.trim().toLowerCase();
    const searchArea = document.getElementById("search-results-area");
    
    if (!searchInput) {
        searchArea.innerHTML = ""; // Linisin ang screen kapag binura lahat ng tinype
        return;
    }

    // 🟢 DEBOUNCE: Maghihintay ng 300ms bago mag-query para hindi mag-spam sa Database
    clearTimeout(searchTimeout);
    
    searchTimeout = setTimeout(async () => {
        searchArea.innerHTML = `<div style="color:#00e5ff; font-size:12px; text-align:center;" class="blink">Scanning Mainframe...</div>`;

        try {
            const usersRef = collection(db, "users");
            
            // 🟢 THE MAGIC TRICK: Prefix Search (Starts With)
            const q = query(
                usersRef, 
                where("searchName", ">=", searchInput),
                where("searchName", "<=", searchInput + "\uf8ff"), // \uf8ff is the highest unicode character
                limit(5) // Ipakita ang top 5 closest matches
            );
            
            const querySnapshot = await getDocs(q);

            if (querySnapshot.empty) {
                searchArea.innerHTML = `<div style="color:#888; font-size:12px; text-align:center;">NO MATCHING AGENTS FOUND</div>`;
                return;
            }

            searchArea.innerHTML = ""; // Clear loader

            querySnapshot.forEach((docSnap) => {
                const agentData = docSnap.data();
                agentData.uid = docSnap.id; 

                // Compute Win Rate & Stats
                let totalMissions = agentData.matchHistory ? agentData.matchHistory.length : 0;
                let wins = agentData.matchHistory ? agentData.matchHistory.filter(m => m.score > 0 && m.accuracy > 50).length : 0;
                let winRate = totalMissions > 0 ? Math.round((wins / totalMissions) * 100) + "%" : "0%";
                
                // Calculate Real Radar Stats
                let realSkills = calculateAgentSkills(agentData.matchHistory);

                const displayData = {
                    uid: agentData.uid,
                    name: agentData.username,
                    rank: getRankInfo(agentData.totalXP || 0).title,
                    avatar: agentData.avatar || "https://img.icons8.com/color/96/000000/astronaut.png",
                    winRate: winRate,
                    missions: totalMissions,
                    topCombo: "Max", 
                    skills: realSkills
                };

                // Inject to UI
                searchArea.innerHTML += `
                    <div class="agent-row" onclick='window.openAgentDossier(${JSON.stringify(displayData)})'>
                        <div style="display:flex; align-items:center; gap:10px;">
                            <img src="${displayData.avatar}" style="width:30px; height:30px; border-radius:50%;">
                            <div>
                                <div class="agent-row-name">${displayData.name}</div>
                                <div class="agent-row-rank">${displayData.rank}</div>
                            </div>
                        </div>
                        <div style="font-size:10px; color:#00e5ff;">VIEW DOSSIER ❯</div>
                    </div>
                `;
            });

        } catch (e) {
            console.error("Search Error:", e);
            searchArea.innerHTML = `<div style="color:#ff0055; font-size:12px; text-align:center;">DATABASE ERROR</div>`;
        }
    }, 300); // 300ms delay execution
};

// 4. Open The Holographic Dossier
window.openAgentDossier = function(agentObj) {
    if(window.Sound) window.Sound.playTone(1000, 'sine', 0.1); // Scanner beep
    
    // Hide Sidebar temporarily if open
    document.getElementById("comms-sidebar").classList.add("closed");
    
    // Populate Data
    document.getElementById("dossier-name").innerText = agentObj.name;
    document.getElementById("dossier-rank").innerText = agentObj.rank;
    document.getElementById("dossier-avatar").src = agentObj.avatar;
    document.getElementById("dossier-winrate").innerText = agentObj.winRate;
    document.getElementById("dossier-missions").innerText = agentObj.missions;
    document.getElementById("dossier-combo").innerText = "x" + agentObj.topCombo;

    // Show Modal
    document.getElementById("agent-dossier-modal").classList.remove("hidden");

    // Reset Compare state
    isComparing = false;
    
    // 5. Render The Radar Chart
    window.renderSkillRadar(agentObj.name, agentObj.skills);
};

window.closeDossier = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("agent-dossier-modal").classList.add("hidden");
    // Pop sidebar back open
    document.getElementById("comms-sidebar").classList.remove("closed");
};

// 6. 🌟 THE PANELIST WOW FACTOR: CHART.JS RADAR 🌟
window.renderSkillRadar = function(agentName, skillsData, mySkillsData = null) {
    const ctx = document.getElementById('skillRadarChart').getContext('2d');
    
    // Destroy old chart if exists to prevent overlapping
    if (radarChartInstance) {
        radarChartInstance.destroy();
    }

    // Default Configuration
    let datasetsConfig = [{
        label: agentName,
        data: skillsData,
        backgroundColor: 'rgba(0, 229, 255, 0.2)', // Light Neon Blue
        borderColor: '#00e5ff',
        pointBackgroundColor: '#fff',
        pointBorderColor: '#00e5ff',
        pointHoverBackgroundColor: '#fff',
        pointHoverBorderColor: '#00e5ff'
    }];

    // If Comparing Stats (Player vs Target)
    if (mySkillsData) {
        datasetsConfig.push({
            label: "YOU (MY STATS)",
            data: mySkillsData,
            backgroundColor: 'rgba(255, 215, 0, 0.2)', // Light Neon Gold
            borderColor: '#ffd700',
            pointBackgroundColor: '#fff',
            pointBorderColor: '#ffd700',
            pointHoverBackgroundColor: '#fff',
            pointHoverBorderColor: '#ffd700'
        });
    }

    radarChartInstance = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: ['ADD (+)', 'SUB (-)', 'MUL (×)', 'DIV (÷)', 'ALG (x)'],
            datasets: datasetsConfig
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            elements: {
                line: { borderWidth: 2 }
            },
            scales: {
                r: {
                    angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' },
                    pointLabels: {
                        color: '#aaa',
                        font: { family: 'Rajdhani', size: 12, weight: 'bold' }
                    },
                    ticks: {
                        display: false, // Hide the numbers inside the web
                        min: 0,
                        max: 100,
                        stepSize: 20
                    }
                }
            },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#fff', font: { family: 'Orbitron', size: 10 } }
                }
            }
        }
    });
};

// 7. Toggle Compare Mode
window.toggleCompareStats = function() {
    if(window.Sound) window.Sound.powerup();
    isComparing = !isComparing;
    
    // Let's pretend this is the current user's data (Dapat galing 'to sa totoong math history mamaya)
    let myFakeSkills = [70, 80, 50, 60, 90]; 
    
    // Re-render chart based on state
    if (isComparing) {
        // Kunin yung data ng naka-open ngayon (Fake data muna na kapareho nung nasa mockSearchAgent)
        let enemyFakeSkills = [85, 90, 60, 40, 70]; 
        let enemyName = document.getElementById("dossier-name").innerText;
        window.renderSkillRadar(enemyName, enemyFakeSkills, myFakeSkills);
    } else {
        let enemyFakeSkills = [85, 90, 60, 40, 70]; 
        let enemyName = document.getElementById("dossier-name").innerText;
        window.renderSkillRadar(enemyName, enemyFakeSkills); // Remove second dataset
    }
};

// ==========================================
// PHASE 3: REAL-TIME SEARCH & FRIENDS LOGIC
// ==========================================

// 1. DYNAMIC RADAR CALCULATOR (The Capstone Magic)
function calculateAgentSkills(history) {
    // Default base stats (10%) para hindi empty ang chart
    let stats = { '+': 10, '-': 10, 'x': 10, '÷': 10, 'Alg': 10 };
    let counts = { '+': 0, '-': 0, 'x': 0, '÷': 0, 'Alg': 0 };

    if (!history || history.length === 0) return [10, 10, 10, 10, 10]; // No data yet

    // Analyze every match
    history.forEach(match => {
        if (match.ops && match.accuracy) {
            match.ops.forEach(op => {
                if (stats[op] !== undefined) {
                    // Add accuracy to the total for that operation
                    stats[op] += match.accuracy;
                    counts[op]++;
                }
            });
        }
    });

    // Calculate Averages
    let finalSkills = [
        counts['+'] > 0 ? Math.min(100, Math.round(stats['+'] / counts['+'])) : 10,
        counts['-'] > 0 ? Math.min(100, Math.round(stats['-'] / counts['-'])) : 10,
        counts['x'] > 0 ? Math.min(100, Math.round(stats['x'] / counts['x'])) : 10,
        counts['÷'] > 0 ? Math.min(100, Math.round(stats['÷'] / counts['÷'])) : 10,
        counts['Alg'] > 0 ? Math.min(100, Math.round(stats['Alg'] / counts['Alg'])) : 10
    ];

    return finalSkills;
}

// 2. REAL DATABASE SEARCH
window.mockSearchAgent = async function() { // We overwrite the mock function
    if(window.Sound) window.Sound.click();
    
    const searchInput = document.getElementById("agent-search-input").value.trim().toLowerCase();
    const searchArea = document.getElementById("search-results-area");
    
    if (!searchInput) {
        searchArea.innerHTML = `<div style="color:#ff0055; font-size:12px; text-align:center;">ENTER A CODENAME</div>`;
        return;
    }

    searchArea.innerHTML = `<div style="color:#00e5ff; font-size:12px; text-align:center;" class="blink">Scanning Firebase Mainframe...</div>`;

    try {
        // Query Firestore for matching searchName
        const usersRef = collection(db, "users");
        const q = query(usersRef, where("searchName", "==", searchInput), limit(3));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            searchArea.innerHTML = `<div style="color:#888; font-size:12px; text-align:center;">AGENT NOT FOUND</div>`;
            return;
        }

        searchArea.innerHTML = ""; // Clear loader

        querySnapshot.forEach((docSnap) => {
            const agentData = docSnap.data();
            agentData.uid = docSnap.id; // Store UID for adding friend later

            // Compute Win Rate & Stats
            let totalMissions = agentData.matchHistory ? agentData.matchHistory.length : 0;
            let wins = agentData.matchHistory ? agentData.matchHistory.filter(m => m.score > 0 && m.accuracy > 50).length : 0;
            let winRate = totalMissions > 0 ? Math.round((wins / totalMissions) * 100) + "%" : "0%";
            
            // Calculate Real Radar Stats
            let realSkills = calculateAgentSkills(agentData.matchHistory);

            const displayData = {
                uid: agentData.uid,
                name: agentData.username,
                rank: getRankInfo(agentData.totalXP || 0).title,
                avatar: agentData.avatar || "https://img.icons8.com/color/96/000000/astronaut.png",
                winRate: winRate,
                missions: totalMissions,
                topCombo: "Max", // Simplification
                skills: realSkills
            };

            // Inject to UI
            searchArea.innerHTML += `
                <div class="agent-row" onclick='window.openAgentDossier(${JSON.stringify(displayData)})'>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img src="${displayData.avatar}" style="width:30px; height:30px; border-radius:50%;">
                        <div>
                            <div class="agent-row-name">${displayData.name}</div>
                            <div class="agent-row-rank">${displayData.rank}</div>
                        </div>
                    </div>
                    <div style="font-size:10px; color:#00e5ff;">VIEW DOSSIER ❯</div>
                </div>
            `;
        });

    } catch (e) {
        console.error("Search Error:", e);
        searchArea.innerHTML = `<div style="color:#ff0055; font-size:12px; text-align:center;">DATABASE ERROR</div>`;
    }
};

// 3. OVERRIDE COMPARE STATS TO USE REAL CURRENT USER DATA
window.toggleCompareStats = function() {
    if(window.Sound) window.Sound.powerup();
    isComparing = !isComparing;
    
    // CALCULATE CURRENT USER'S REAL STATS
    let myRealSkills = calculateAgentSkills(currentUser.matchHistory); 
    
    // Get target's name
    let enemyName = document.getElementById("dossier-name").innerText;
    
    // We stored the target's skills in a global temp var during openAgentDossier
    let targetSkills = window.currentTargetSkills || [10,10,10,10,10];

    if (isComparing) {
        window.renderSkillRadar(enemyName, targetSkills, myRealSkills);
    } else {
        window.renderSkillRadar(enemyName, targetSkills); 
    }
};

// Update openAgentDossier slightly to store the target's skills for comparison
const oldOpenDossier = window.openAgentDossier;
window.openAgentDossier = function(agentObj) {
    window.currentTargetSkills = agentObj.skills; // Save for compare button
    
    // Check if looking at own profile
    const reqBtn = document.getElementById("btn-add-ally");
    if (reqBtn) {
        if (agentObj.uid === currentUser.uid) {
            reqBtn.style.display = 'none'; // Can't add yourself
        } else {
            reqBtn.style.display = 'block';
            reqBtn.onclick = () => window.sendAllyRequest(agentObj.uid, agentObj.name);
        }
    }
    
    oldOpenDossier(agentObj);
};

// 4. SEND FRIEND REQUEST
window.sendAllyRequest = async function(targetUid, targetName) {
    if (!currentUser) return;
    if(window.Sound) window.Sound.click();

    const btn = document.getElementById("btn-add-ally");
    btn.innerText = "SENDING...";
    btn.disabled = true;

    try {
        const targetRef = doc(db, "users", targetUid);
        
        // Push the CURRENT USER'S info into the TARGET'S friendRequests array
        await updateDoc(targetRef, {
            friendRequests: arrayUnion({
                uid: currentUser.uid,
                name: currentUser.username,
                avatar: currentUser.avatar || "https://img.icons8.com/color/96/000000/astronaut.png"
            })
        });

        btn.innerText = "✅ REQUEST SENT";
        btn.style.color = "#00ff41";
        btn.style.borderColor = "#00ff41";
        
    } catch(e) {
        console.error(e);
        btn.innerText = "❌ FAILED";
        btn.disabled = false;
    }
}

// 5. LIVE SOCKET INVITES
if (socket) {
    // 🟢 GOD-LEVEL FEATURE: RECEIVE SPY CAM (Teacher Side)
    socket.on('receive_spy_frame', (data) => {
        if (state.gameMode === 'classroom' && isHost) {
            const camImage = document.getElementById(`spy-cam-${data.uid}`);
            if (camImage) {
                camImage.src = data.frame; // Update the CCTV screen!
            }
        }
    });
    // Kapag nakatanggap ka ng invite mula sa ibang player
    socket.on('receive_invite', (data) => {
        // Huwag istorbohin kung naglalaro siya ng Solo/Class
        if (state.isPlaying && state.gameMode !== 'party') return; 

        if (window.Sound) window.Sound.playTone(800, 'square', 0.2); // Alert Sound
        
        const popup = document.getElementById("live-invite-popup");
        const msg = document.getElementById("invite-msg");
        const acceptBtn = document.getElementById("btn-accept-invite");

        msg.innerHTML = `Agent <b style="color:#00e5ff;">${data.senderName}</b> is requesting backup in Room <b style="color:#ffd700;">${data.roomCode}</b>!`;
        
        popup.classList.remove("hidden");

        // Ano ang mangyayari pag ni-click ang Accept?
        acceptBtn.onclick = function() {
            popup.classList.add("hidden");
            if (window.Sound) window.Sound.powerup();
            
            // Isara ang mga menu at i-force join ang room
            document.getElementById("start-modal").classList.add("hidden");
            document.getElementById("comms-sidebar").classList.add("closed");
            
            const joinInput = document.getElementById("join-code-input");
            if(joinInput) {
                joinInput.value = data.roomCode;
                window.joinRoom(); // Use your existing join function!
            }
        };
        
        // Auto-hide popup after 10 seconds
        setTimeout(() => { popup.classList.add("hidden"); }, 10000);
    });
}

// Function para mag-send ng Invite sa Kaibigan (Ilalagay natin ang button na 'to mamaya sa Friends List tab)
window.sendLiveInvite = function(friendSocketId) {
    if (!currentRoomId) {
        alert("You must create a Multiplayer/Team Lobby first!");
        return;
    }
    
    socket.emit('send_invite', {
        targetSocket: friendSocketId,
        senderName: myName,
        roomCode: currentRoomId
    });
    
    alert("Invite Sent!");
};

// ==========================================
// PHASE 4: SOCIAL LOOP & TEACHER REPORTS
// ==========================================

window.activeInviteShowing = false; // Flag para hindi mag-spam ang popup

// 1. REAL-TIME COMMS LISTENER (Updates Sidebar & Popups Automatically)
window.initCommsListener = function() {
    if (!currentUser || !currentUser.uid) return;
    
    const userRef = doc(db, "users", currentUser.uid);
    onSnapshot(userRef, (docSnap) => {
        if (docSnap.exists()) {
            let data = docSnap.data();
            currentUser = { ...currentUser, ...data };
            
            
            if(window.renderCommsFriends) window.renderCommsFriends();

            // Find this inside window.initCommsListener
if(window.renderCommsRequests) window.renderCommsRequests();

// Add this immediately after:
const toggleBtn = document.getElementById("comms-toggle-btn");
// If there are pending requests or invites, trigger the radar ping!
if (data.friendRequests && data.friendRequests.length > 0) {
    if (!document.getElementById("radar-ping-element")) {
        toggleBtn.innerHTML += `<div id="radar-ping-element" class="radar-pulse"></div>`;
    }
    toggleBtn.style.color = "#ff0055"; // Turn text red
    toggleBtn.style.borderColor = "#ff0055";
} else {
    const ping = document.getElementById("radar-ping-element");
    if (ping) ping.remove();
    toggleBtn.style.color = "#00e5ff"; // Back to normal
    toggleBtn.style.borderColor = "#00e5ff";
}

            // 🟢 CHECK FOR LIVE INVITES (THE POPUP TRIGGER)
            if (data.liveInvite) {
                let inviteAge = Date.now() - data.liveInvite.timestamp;
                
                // Ipakita lang kung ang invite ay bago (Wala pang 15 seconds)
                if (inviteAge < 15000 && !window.activeInviteShowing) {
                    window.showLiveInvitePopup(data.liveInvite.senderName, data.liveInvite.roomCode);
                }
            }
        }
    });
};

// 2. RENDER PENDING REQUESTS
window.renderCommsRequests = function() {
    const reqArea = document.getElementById("comms-requests");
    const pingDot = document.getElementById("comms-ping");
    const reqs = currentUser.friendRequests || [];
    
    if (reqs.length === 0) {
        reqArea.innerHTML = `<div style="color:#aaa; font-size:12px; text-align:center; margin-top:20px;">No pending requests.</div>`;
        if(pingDot) pingDot.classList.add("hidden"); // Hide Red Dot
        return;
    }

    if(pingDot) pingDot.classList.remove("hidden"); // Show Red Dot!

    let html = "";
    reqs.forEach(req => {
        html += `
        <div class="agent-row" style="cursor:default; border-color:#ffd700;">
            <div style="display:flex; align-items:center; gap:10px;">
                <img src="${req.avatar}" style="width:30px; height:30px; border-radius:50%;">
                <div class="agent-row-name">${req.name}</div>
            </div>
            <div style="display:flex; gap:5px;">
                <button class="btn primary" style="padding:5px 10px; font-size:10px; margin:0;" onclick="window.acceptAlly('${req.uid}', '${req.name}', '${req.avatar}')">✔ ACCEPT</button>
                <button class="btn secondary" style="padding:5px 10px; font-size:10px; margin:0; border-color:#ff0055; color:#ff0055;" onclick="window.rejectAlly('${req.uid}', '${req.name}', '${req.avatar}')">✖</button>
            </div>
        </div>`;
    });
    reqArea.innerHTML = html;
};

// 3. ACCEPT / REJECT LOGIC
window.acceptAlly = async function(targetUid, targetName, targetAvatar) {
    if(window.Sound) window.Sound.powerup();
    try {
        const myRef = doc(db, "users", currentUser.uid);
        const myDataObj = { uid: currentUser.uid, name: currentUser.username, avatar: currentUser.avatar || "https://img.icons8.com/color/96/000000/astronaut.png" };
        const targetObj = { uid: targetUid, name: targetName, avatar: targetAvatar };

        // Remove from Requests, Add to Friends (For Current User)
        await updateDoc(myRef, {
            friendRequests: arrayRemove(targetObj),
            friends: arrayUnion(targetObj)
        });

        // Add Current User to Target's Friends list
        const targetRef = doc(db, "users", targetUid);
        await updateDoc(targetRef, {
            friends: arrayUnion(myDataObj)
        });
        
    } catch(e) { console.error("Accept Error", e); }
};

window.rejectAlly = async function(targetUid, targetName, targetAvatar) {
    if(window.Sound) window.Sound.error();
    try {
        const myRef = doc(db, "users", currentUser.uid);
        await updateDoc(myRef, {
            friendRequests: arrayRemove({ uid: targetUid, name: targetName, avatar: targetAvatar })
        });
    } catch(e) { console.error(e); }
};

window.renderCommsFriends = function() {
    const friendsArea = document.getElementById("comms-friends");
    const friends = currentUser.friends || [];

    if (friends.length === 0) {
        friendsArea.innerHTML = `<div style="color:#aaa; font-size:12px; text-align:center; margin-top:20px;">No allies found.<br><br>Go to the SEARCH tab to recruit agents.</div>`;
        return;
    }

    let html = "";
    friends.forEach(f => {
        html += `
        <div class="agent-row">
            <div style="display:flex; align-items:center; gap:10px; flex-grow:1; cursor:pointer;" onclick="window.fetchAndViewDossier('${f.uid}')">
                <img src="${f.avatar}" style="width:30px; height:30px; border-radius:50%;">
                <div class="agent-row-name">${f.name}</div>
            </div>
            <div style="display:flex; gap: 5px;">
                <button class="btn secondary" style="padding:6px 10px; font-size:10px; margin:0; border-color:#00e5ff; color:#00e5ff;" onclick="window.openChat('${f.uid}', '${f.name}')">💬</button>
                <button class="btn secondary" style="padding:6px 10px; font-size:10px; margin:0;" onclick="window.inviteFriend('${f.uid}')">INVITE</button>
            </div>
        </div>`;
    });
    friendsArea.innerHTML = html;
};

// Open Dossier by clicking a friend
window.fetchAndViewDossier = async function(uid) {
    if(window.Sound) window.Sound.click();
    try {
        const docSnap = await getDoc(doc(db, "users", uid));
        if (docSnap.exists()) {
            let data = docSnap.data();
            let totalMissions = data.matchHistory ? data.matchHistory.length : 0;
            let wins = data.matchHistory ? data.matchHistory.filter(m => m.score > 0 && m.accuracy > 50).length : 0;
            let winRate = totalMissions > 0 ? Math.round((wins / totalMissions) * 100) + "%" : "0%";
            
            // Re-use our dynamic radar calculator from Phase 3
            let realSkills = calculateAgentSkills(data.matchHistory);
            
            const displayData = {
                uid: docSnap.id,
                name: data.username,
                rank: getRankInfo(data.totalXP || 0).title,
                avatar: data.avatar || "https://img.icons8.com/color/96/000000/astronaut.png",
                winRate: winRate,
                missions: totalMissions,
                topCombo: "Max",
                skills: realSkills
            };
            window.openAgentDossier(displayData);
        }
    } catch(e) { console.log(e); }
};

// Send Live Invite Event via Socket
// Send Live Invite Event via FIRESTORE (100% Reliable)
window.inviteFriend = async function(targetUid) {
    if(window.Sound) window.Sound.click();
    
    if (!currentRoomId) {
        alert("COMMANDER: You must CREATE a Multiplayer Lobby first before inviting!");
        return;
    }
    
    try {
        // Isusulat natin ang invite sa Profile ng kaibigan mo
        const targetRef = doc(db, "users", targetUid);
        await updateDoc(targetRef, {
            liveInvite: {
                senderName: myName,
                roomCode: currentRoomId,
                timestamp: Date.now() // Lagyan ng oras para hindi lumabas ang lumang invites
            }
        });
        alert("TRANSMISSION SENT! Waiting for backup...");
    } catch(e) {
        console.error("Invite Error:", e);
        alert("Failed to send transmission.");
    }
};

// 5. TEACHER'S INTERVENTION REPORT GENERATOR
window.generateInterventionReport = function(studentName, accuracy, weakness) {
    if(window.Sound) window.Sound.click();
    
    // Set Date
    document.getElementById("report-date").innerText = new Date().toLocaleDateString();
    
    // Set Data
    document.getElementById("report-student-name").innerText = studentName;
    document.getElementById("report-acc").innerText = accuracy + "%";
    document.getElementById("report-weakness").innerText = weakness;

    // Generate Smart Action Plan based on weakness
    let actionPlan = "";
    if (weakness === "ADD") actionPlan = "Agent requires foundational drills in carrying over numbers and basic addition facts.";
    else if (weakness === "SUB") actionPlan = "Agent struggles with borrowing and negative logic. Suggesting visual number line exercises.";
    else if (weakness === "MUL") actionPlan = "Agent needs to review multiplication tables. Rote memorization and grouping strategies recommended.";
    else if (weakness === "DIV") actionPlan = "Agent has difficulty breaking down large groups. Suggesting inverse-multiplication practice.";
    else if (weakness === "ALG") actionPlan = "Agent is struggling with isolating variables. Recommend starting with basic one-step inverse operations (e.g. x + 5 = 10).";
    else actionPlan = "Agent is performing optimally. Continue current tactical trajectory.";

    document.getElementById("report-action-plan").innerText = actionPlan;

    // Show Modal
    document.getElementById("intervention-report-modal").classList.remove("hidden");
};

// Trigger the native browser Print
window.printReport = function() {
    window.print();
};

// SA LOOB NG IYONG SERVER.JS (BACKEND)

// Gumawa ng object para i-store kung anong socket.id ang gamit ng bawat UID


window.activeInviteShowing = false; // Flag para hindi mag-spam ang popup


// POPUP CONTROLLER LOGIC
window.showLiveInvitePopup = function(senderName, roomCode) {
    // Huwag istorbohin kung nasa kalagitnaan ng laban (Solo/Class)
    if (state.isPlaying && state.gameMode !== 'party') return; 

    window.activeInviteShowing = true;
    if (window.Sound) window.Sound.playTone(800, 'square', 0.2); // Alert Beep
    
    const popup = document.getElementById("live-invite-popup");
    const msg = document.getElementById("invite-msg");
    const acceptBtn = document.getElementById("btn-accept-invite");
    const declineBtn = document.getElementById("btn-decline-invite");

    msg.innerHTML = `Agent <b style="color:#00e5ff;">${senderName}</b> is requesting backup in Room <b style="color:#ffd700;">${roomCode}</b>!`;
    popup.classList.remove("hidden");

    // 🟢 ACCEPT LOGIC
    acceptBtn.onclick = async function() {
        popup.classList.add("hidden");
        window.activeInviteShowing = false;
        if (window.Sound) window.Sound.powerup();
        
        // Isara ang mga menus at mag-join
        document.getElementById("start-modal").classList.add("hidden");
        const sidebar = document.getElementById("comms-sidebar");
        if(sidebar) sidebar.classList.add("closed");
        
        const joinInput = document.getElementById("join-code-input");
        if(joinInput) {
            joinInput.value = roomCode;
            window.joinRoom(); 
        }
        
        // Linisin ang invite sa Database
        await updateDoc(doc(db, "users", currentUser.uid), { liveInvite: null });
    };

    // 🔴 DECLINE LOGIC
    declineBtn.onclick = async function() {
        popup.classList.add("hidden");
        window.activeInviteShowing = false;
        if (window.Sound) window.Sound.click();
        
        // Linisin ang invite sa Database
        await updateDoc(doc(db, "users", currentUser.uid), { liveInvite: null });
    };

    // 🕒 AUTO-HIDE AFTER 10 SECONDS
    setTimeout(async () => { 
        if(window.activeInviteShowing) {
            popup.classList.add("hidden"); 
            window.activeInviteShowing = false;
            // Clear expired invite
            await updateDoc(doc(db, "users", currentUser.uid), { liveInvite: null });
        }
    }, 10000);
};

// ==========================================
// 📡 LIVE INVITE POPUP SYSTEM (FIRESTORE)
// ==========================================

window.activeInviteShowing = false; 

window.showLiveInvitePopup = function(senderName, roomCode) {
    // Huwag istorbohin kung nasa kalagitnaan ng laban
    if (state.isPlaying && state.gameMode !== 'party') return; 

    window.activeInviteShowing = true;
    if (window.Sound) window.Sound.playTone(800, 'square', 0.2); // Alert Beep
    
    const popup = document.getElementById("live-invite-popup");
    const msg = document.getElementById("invite-msg");
    const acceptBtn = document.getElementById("btn-accept-invite");
    const declineBtn = document.getElementById("btn-decline-invite");

    msg.innerHTML = `Agent <b style="color:#00e5ff;">${senderName}</b> is requesting backup in Room <b style="color:#ffd700;">${roomCode}</b>!`;
    popup.classList.remove("hidden");

    // 🟢 ACCEPT LOGIC
    acceptBtn.onclick = async function() {
        popup.classList.add("hidden");
        window.activeInviteShowing = false;
        if (window.Sound) window.Sound.powerup();
        
        // Isara ang mga menus at mag-join
        document.getElementById("start-modal").classList.add("hidden");
        const sidebar = document.getElementById("comms-sidebar");
        if(sidebar) sidebar.classList.add("closed");
        
        const joinInput = document.getElementById("join-code-input");
        if(joinInput) {
            joinInput.value = roomCode;
            window.joinRoom(); 
        }
        
        // Linisin ang invite sa Database
        await updateDoc(doc(db, "users", currentUser.uid), { liveInvite: null });
    };

    // 🔴 DECLINE LOGIC
    declineBtn.onclick = async function() {
        popup.classList.add("hidden");
        window.activeInviteShowing = false;
        if (window.Sound) window.Sound.click();
        
        // Linisin ang invite sa Database
        await updateDoc(doc(db, "users", currentUser.uid), { liveInvite: null });
    };

    // 🕒 AUTO-HIDE AFTER 10 SECONDS
    setTimeout(async () => { 
        if(window.activeInviteShowing) {
            popup.classList.add("hidden"); 
            window.activeInviteShowing = false;
            await updateDoc(doc(db, "users", currentUser.uid), { liveInvite: null });
        }
    }, 10000);
};

// 1. Tenga ng Player (Listener)
window.initCommsListener = function() {
    if (!currentUser || !currentUser.uid) return;
    
    const userRef = doc(db, "users", currentUser.uid);
    onSnapshot(userRef, (docSnap) => {
        if (docSnap.exists()) {
            let data = docSnap.data();
            currentUser = { ...currentUser, ...data };
            
            // Update Sidebar Lists
            if(window.renderCommsRequests) window.renderCommsRequests();
            if(window.renderCommsFriends) window.renderCommsFriends();

            // 🟢 CHECK FOR LIVE INVITES (THE POPUP TRIGGER)
            if (data.liveInvite) {
                let inviteAge = Date.now() - data.liveInvite.timestamp;
                // Ipakita lang kung bago ang invite (wala pang 15 seconds)
                if (inviteAge < 15000 && !window.activeInviteShowing) {
                    window.showLiveInvitePopup(data.liveInvite.senderName, data.liveInvite.roomCode);
                }
            }
        }
    });
};


// ==========================================
// 📡 LIVE COMMS & SOCIAL LOOP
// ==========================================

window.activeInviteShowing = false; 

// 1. Tenga ng Player (Listen to DB for Friends/Requests)
window.initCommsListener = function() {
    if (!currentUser || !currentUser.uid) return;
    
    // 🟢 I-force send ang UID sa Server para sure na alam niyang Online ka
    if(socket && socket.connected) {
        socket.emit('register_player', { name: currentUser.username, uid: currentUser.uid });
    }
    
    const userRef = doc(db, "users", currentUser.uid);
    onSnapshot(userRef, (docSnap) => {
        if (docSnap.exists()) {
            let data = docSnap.data();
            currentUser = { ...currentUser, ...data };
            
            // Update Sidebar Lists
            if(window.renderCommsRequests) window.renderCommsRequests();
            if(window.renderCommsFriends) window.renderCommsFriends();

            // 🟢 MULTIPLAYER INVITE POPUP (Galing sa Database)
            if (data.liveInvite) {
                let inviteAge = Date.now() - data.liveInvite.timestamp;
                // Ipakita lang kung bago ang invite (wala pang 15 seconds)
                if (inviteAge < 15000 && !window.activeInviteShowing) {
                    window.showMultiplayerInvitePopup(data.liveInvite.senderName, data.liveInvite.roomCode);
                }
            }
        }
    });
};

// 2. MULTIPLAYER LOBBY INVITE POPUP (Para mag-join sa laro)
window.showMultiplayerInvitePopup = function(senderName, roomCode) {
    if (state.isPlaying && state.gameMode !== 'party') return; 

    window.activeInviteShowing = true;
    if (window.Sound) window.Sound.playTone(800, 'square', 0.2); 
    
    const popup = document.getElementById("live-invite-popup");
    const msg = document.getElementById("invite-msg");
    const acceptBtn = document.getElementById("btn-accept-invite");
    const declineBtn = document.getElementById("btn-decline-invite");

    msg.innerHTML = `Agent <b style="color:#00e5ff;">${senderName}</b> is requesting backup in Room <b style="color:#ffd700;">${roomCode}</b>!`;
    popup.classList.remove("hidden");

    acceptBtn.onclick = async function() {
        popup.classList.add("hidden");
        window.activeInviteShowing = false;
        if (window.Sound) window.Sound.powerup();
        
        document.getElementById("start-modal").classList.add("hidden");
        const sidebar = document.getElementById("comms-sidebar");
        if(sidebar) sidebar.classList.add("closed");
        
        const joinInput = document.getElementById("join-code-input");
        if(joinInput) {
            joinInput.value = roomCode;
            window.joinRoom(); 
        }
        await updateDoc(doc(db, "users", currentUser.uid), { liveInvite: null });
    };

    declineBtn.onclick = async function() {
        popup.classList.add("hidden");
        window.activeInviteShowing = false;
        if (window.Sound) window.Sound.click();
        await updateDoc(doc(db, "users", currentUser.uid), { liveInvite: null });
    };

    setTimeout(async () => { 
        if(window.activeInviteShowing) {
            popup.classList.add("hidden"); 
            window.activeInviteShowing = false;
            await updateDoc(doc(db, "users", currentUser.uid), { liveInvite: null });
        }
    }, 10000);
};

// 3. SEND GAME INVITE
window.inviteFriend = async function(targetUid) {
    if(window.Sound) window.Sound.click();
    if (!currentRoomId) return alert("COMMANDER: You must CREATE a Multiplayer Lobby first before inviting!");
    
    try {
        const targetRef = doc(db, "users", targetUid);
        await updateDoc(targetRef, {
            liveInvite: {
                senderName: myName,
                roomCode: currentRoomId,
                timestamp: Date.now() 
            }
        });
        alert("TRANSMISSION SENT! Waiting for backup...");
    } catch(e) {
        console.error("Invite Error:", e);
        alert("Failed to send transmission.");
    }
};

// ==========================================
// 💬 SECURE DIRECT MESSAGING (TEXT CHAT)
// ==========================================

let currentChatUserId = null;
let chatUnsubscribe = null;

const badWords = ["bobo", "tanga", "gago", "fuck", "shit", "puta", "putangina"];

function filterProfanity(text) {
    let filteredText = text;
    badWords.forEach(word => {
        const regex = new RegExp(word, "gi");
        filteredText = filteredText.replace(regex, "***");
    });
    return filteredText;
}

function getChatId(uid1, uid2) {
    return uid1 < uid2 ? `${uid1}_${uid2}` : `${uid2}_${uid1}`;
}

window.openChat = function(targetUid, targetName) {
    if(window.Sound) window.Sound.click();
    currentChatUserId = targetUid;
    
    document.getElementById("comms-friends").classList.add("hidden");
    document.getElementById("comms-requests").classList.add("hidden");
    document.getElementById("comms-search").classList.add("hidden");
    
    document.getElementById("comms-chat").classList.remove("hidden");
    document.getElementById("chat-target-name").innerText = targetName;
    
    const chatId = getChatId(currentUser.uid, targetUid);
    const chatRef = collection(db, "chats", chatId, "messages");
    const q = query(chatRef, orderBy("timestamp", "asc"));
    
    if(chatUnsubscribe) chatUnsubscribe();
    
    const messagesDiv = document.getElementById("chat-messages");
    messagesDiv.innerHTML = `<div style="text-align:center; color:#555; font-size:10px; margin-top:10px;">-- SECURE END-TO-END ENCRYPTION ACTIVE --</div>`;
    
    chatUnsubscribe = onSnapshot(q, (snapshot) => {
        messagesDiv.innerHTML = "";
        snapshot.forEach((doc) => {
            const msg = doc.data();
            const isMine = msg.senderUid === currentUser.uid;
            messagesDiv.innerHTML += `
                <div class="chat-bubble ${isMine ? 'chat-mine' : 'chat-theirs'}">
                    ${msg.text}
                </div>
            `;
        });
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    });
};

window.closeChat = function() {
    if(window.Sound) window.Sound.click();
    if(chatUnsubscribe) chatUnsubscribe();
    currentChatUserId = null;
    document.getElementById("comms-chat").classList.add("hidden");
    window.switchCommsTab('friends');
};

window.sendChatMessage = async function() {
    const input = document.getElementById("chat-input");
    let rawText = input.value.trim();
    if(!rawText || !currentChatUserId) return;
    
    let safeText = filterProfanity(rawText);
    input.value = "";
    
    const chatId = getChatId(currentUser.uid, currentChatUserId);
    const chatRef = collection(db, "chats", chatId, "messages");
    
    try { await addDoc(chatRef, { senderUid: currentUser.uid, text: safeText, timestamp: Date.now() }); } 
    catch(e) { console.error("Chat error:", e); }
};

// ==========================================
// 🎙️ TACTICAL VOICE COMMS (WebRTC)
// ==========================================

let peerConnection = null;
let localStream = null;
let currentCallTargetSocket = null;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};



// 2. SOCKET LISTENERS FOR VOICE CALL (Prevent Duplicate Listeners)
if (socket) {
    socket.off('incoming_voice_call');
    socket.off('call_accepted');
    socket.off('call_rejected');
    socket.off('webrtc_offer');
    socket.off('webrtc_answer');
    socket.off('webrtc_ice_candidate');
    socket.off('call_ended');

    // Kapag may tumatawag sayo
    socket.on('incoming_voice_call', (data) => {
        console.log("🚨 VOICE SIGNAL RECEIVED FROM:", data.callerName);
        
        // 🟢 DO NOT DISTURB
        if (state.isPlaying) {
            console.log("Auto-rejecting call: Player is busy.");
            socket.emit('reject_voice_call', { targetSocket: data.callerSocketId, reason: "IN_MISSION" });
            return; 
        }

        // Gamitin ang parehong popup ng game invite, pero ibahin ang design at behavior
        const popup = document.getElementById("live-invite-popup");
        const msg = document.getElementById("invite-msg");
        const acceptBtn = document.getElementById("btn-accept-invite");
        const declineBtn = document.getElementById("btn-decline-invite");
        
        window.incomingCallData = data; 
        
        // Ibahin ang text para alam mong VOICE call ito
        popup.querySelector('h4').innerText = "📡 INCOMING VOICE COMMS";
        msg.innerHTML = `Agent <b style="color:#00e5ff;">${data.callerName}</b> is attempting to establish a secure voice link.`;
        popup.classList.remove("hidden");
        
        if(window.Sound) window.Sound.playTone(600, 'sine', 0.5); 

        // ACCEPT LOGIC
        acceptBtn.onclick = function() {
            popup.classList.add("hidden");
            currentCallTargetSocket = data.callerSocketId;
            socket.emit('accept_voice_call', { targetSocket: currentCallTargetSocket });
            
            // Ipakita yung Call UI
            document.getElementById("active-call-ui").classList.remove("hidden");
            document.getElementById("active-call-name").innerText = data.callerName;
            
            // Palitan pabalik ang title ng popup pagkatapos
            popup.querySelector('h4').innerText = "⚠️ INCOMING TRANSMISSION";
        };

        // DECLINE LOGIC
        declineBtn.onclick = function() {
            popup.classList.add("hidden");
            socket.emit('reject_voice_call', { targetSocket: data.callerSocketId, reason: "DECLINED" });
            if(window.Sound) window.Sound.click();
            
            // Palitan pabalik ang title ng popup
            popup.querySelector('h4').innerText = "⚠️ INCOMING TRANSMISSION";
        };
    });

    socket.on('call_accepted', async (data) => {
        console.log("✅ Call Accepted by Target!");
        currentCallTargetSocket = data.acceptorSocketId;
        document.getElementById("active-call-ui").classList.remove("hidden");
        document.getElementById("active-call-name").innerText = "CONNECTED";
        document.getElementById("chat-target-name").innerText = "IN CALL";
        await setupWebRTC(true);
    });

    socket.on('call_rejected', (data) => {
        let reason = data && data.reason ? data.reason : "DECLINED";
        console.log("❌ Call Failed:", reason);
        
        if (reason === "IN_MISSION") {
            alert("Connection Failed: The agent is currently in active combat.");
            document.getElementById("chat-target-name").innerText = "AGENT BUSY";
        } else if (reason === "OFFLINE") {
            alert("Connection Failed: Agent is offline or on another relay.");
            document.getElementById("chat-target-name").innerText = "AGENT OFFLINE";
        } else {
            alert("The agent declined your transmission.");
            document.getElementById("chat-target-name").innerText = "CALL DECLINED";
        }
        
        if(window.Sound) window.Sound.error();

        setTimeout(() => {
            if (currentUser && currentUser.friends && currentChatUserId) {
                const friend = currentUser.friends.find(f => f.uid === currentChatUserId);
                if (document.getElementById("chat-target-name")) {
                    document.getElementById("chat-target-name").innerText = friend ? friend.name : "AGENT";
                }
            }
        }, 3000);
    });

    socket.on('webrtc_offer', async (data) => {
        await setupWebRTC(false);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('webrtc_answer', { targetSocket: currentCallTargetSocket, answer: answer });
    });

    socket.on('webrtc_answer', async (data) => {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    });

    socket.on('webrtc_ice_candidate', async (data) => {
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    });

    socket.on('call_ended', () => {
        console.log("📵 Call ended by partner.");
        window.closeCallCleanup();
    });
}


window.endVoiceCall = function() {
    if (currentCallTargetSocket) {
        socket.emit('end_voice_call', { targetSocket: currentCallTargetSocket });
    }
    window.closeCallCleanup();
};

window.closeCallCleanup = function() {
    document.getElementById("active-call-ui").classList.add("hidden");
    
    if (currentUser && currentUser.friends && currentChatUserId) {
        const friend = currentUser.friends.find(f => f.uid === currentChatUserId);
        if (document.getElementById("chat-target-name")) {
            document.getElementById("chat-target-name").innerText = friend ? friend.name : "AGENT";
        }
    }

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    currentCallTargetSocket = null;
    let remoteAudio = document.getElementById('remote-audio');
    if(remoteAudio) remoteAudio.srcObject = null;
};





// ==========================================
// 🎁 REWARDS & LOOT SYSTEM LOGIC
// ==========================================

window.proceedCampaignVictory = async function() {
    // 1. Isara ang Victory Screen
    document.getElementById("win-modal").classList.add("hidden");

    let lvl = window.pendingRewardLevel;
    window.pendingRewardLevel = null; // Clear it to prevent looping

    // 2. CHECK MILESTONES
    if (lvl) {
        // --- THE 4 ARTIFACT SKINS (Exclusive) ---
        if (lvl === 30) return await showRewardModal('artifact', 'PHANTOM SHIP', '🥷', 'turret_phantom', 0);
        if (lvl === 50) return await showRewardModal('artifact', 'AEGIS CRUISER', '🛡️', 'turret_aegis', 0);
        if (lvl === 70) return await showRewardModal('artifact', 'DARK MATTER DRIVE', '🌌', 'fx_void', 0);
        if (lvl === 100) return await showRewardModal('artifact', 'GOD-CORE', '👁️', 'turret_god', 0);

        // --- SUPPLY DROPS (Every 5 Levels) ---
        if (lvl % 5 === 0) {
            let coinPrize = lvl * 50; // Lumalaki ang bigay! Lvl 5 = 250c, Lvl 10 = 500c
            return await showRewardModal('supply', 'SECTOR CACHE', '📦', null, coinPrize);
        }
    }
    
    // 3. Kung walang reward (Normal levels), diretso bukas agad ng Map.
    window.openCampaignMap();
};

window.showRewardModal = async function(type, title, icon, itemToUnlock, coinsGiven) {
    if(window.Sound) window.Sound.playBGM('intro'); // Epic music
    
    const modal = document.getElementById("reward-modal");
    const glowBox = document.getElementById("reward-icon-container");
    
    document.getElementById("reward-title").innerText = type === 'artifact' ? "ARTIFACT ACQUIRED!" : "SUPPLY SECURED!";
    document.getElementById("reward-icon").innerText = icon;
    
    if (type === 'artifact') {
        document.getElementById("reward-name").innerText = title;
        document.getElementById("reward-desc").innerText = "CLASSIFIED SKIN ADDED TO ARMORY.";
        glowBox.className = "reward-glow-box artifact-glow"; // Purple glow
        
        // Add to Database Inventory
        if (currentUser && !currentUser.inventory.includes(itemToUnlock)) {
            currentUser.inventory.push(itemToUnlock);
        }
    } else {
        document.getElementById("reward-name").innerText = `+${coinsGiven} COINS`;
        document.getElementById("reward-desc").innerText = title;
        glowBox.className = "reward-glow-box"; // Gold glow
        
        // Add Coins to State
        state.coins += coinsGiven;
    }

    // Save changes to Firebase instantly
    if (currentUser && currentUser.uid) {
        await updateDoc(doc(db, "users", currentUser.uid), {
            inventory: currentUser.inventory,
            coins: state.coins
        });
    }

    // Show UI
    modal.classList.remove("hidden");
};

window.closeRewardModal = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("reward-modal").classList.add("hidden");
    
    // After claiming, open the map
    window.openCampaignMap();
};

// 🟢 ADD SECRET SKINS TO SHOP CATALOG (So it renders in the Armory when they check)
// Hanapin ang 'shopCatalog' object mo sa script.js at idagdag ang mga ito sa 'ships' at 'fx':
shopCatalog.ships.push({ id: 'turret_phantom', subtype: 'turret', name: 'Phantom', price: 'LOCKED', img: 'ship_default.png', desc: 'Campaign Lvl 30 Reward.' });
shopCatalog.ships.push({ id: 'turret_aegis', subtype: 'turret', name: 'Aegis', price: 'LOCKED', img: 'ship_default.png', desc: 'Campaign Lvl 50 Reward.' });
shopCatalog.ships.push({ id: 'turret_god', subtype: 'turret', name: 'N.E.X.U.S. Core', price: 'LOCKED', img: 'ship_default.png', desc: 'Campaign Lvl 100 Reward.' });
shopCatalog.fx.push({ id: 'fx_void', name: 'Dark Matter', price: 'LOCKED', color: '#b000ff', aura: 'void', desc: 'Campaign Lvl 70 Reward.' });

// ==========================================
// 🚀 CAMPAIGN MODE LEVEL STARTER
// ==========================================

window.startCampaignLevel = function(levelNum) {
    if(window.Sound) window.Sound.click();
    
    // 1. Isara ang Map Modal at Ipakita ang Main Game UI
    document.getElementById("campaign-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.add("hidden");

    // 2. Set the Game Mode to Campaign
    state.gameMode = 'campaign';
    state.currentCampaignLevel = levelNum;

    // 3. Setup Difficulty based on Level (Sector Logic)
    if (levelNum <= 20) {
        state.difficulty = 'easy';
        state.selectedOps = ['+', '-'];
    } else if (levelNum <= 50) {
        state.difficulty = 'medium';
        state.selectedOps = ['x', '÷'];
    } else if (levelNum <= 80) {
        state.difficulty = 'hard';
        state.selectedOps = ['+', '-', 'x', '÷']; // Mixed Integers
    } else {
        state.difficulty = 'hard';
        state.selectedOps = ['Alg']; // Algebra
    }

    // Adjust Spawn Rate para bumilis habang tumataas ang level
    let baseSpawn = 2500;
    if (state.difficulty === 'easy') baseSpawn = 3000;
    if (state.difficulty === 'hard') baseSpawn = 1800;
    
    // Bibilis ng 15ms bawat level
    state.spawnRate = Math.max(800, baseSpawn - (levelNum * 15)); 

    console.log(`Starting Campaign Level: ${levelNum} | Difficulty: ${state.difficulty} | Rate: ${state.spawnRate}`);

    // 4. Start the Engine!
    startGameLogic();
};

// ==========================================
// 🚀 MASTER CAMPAIGN CONTROLLERS (BUTTON FIX)
// ==========================================

// 1. OPEN MAP BUTTON (Main Menu -> Campaign)
window.openCampaignMap = function() {
    console.log("SYSTEM: Opening Campaign Map..."); 
    if(window.Sound) window.Sound.click();
    
    const startModal = document.getElementById("start-modal");
    const campModal = document.getElementById("campaign-modal");
    
    if(startModal) startModal.classList.add("hidden");
    if(campModal) campModal.classList.remove("hidden");
    
    // I-render ang map nodes
    if(typeof window.renderCampaignGrid === "function") {
        window.renderCampaignGrid();
    } else {
        console.error("ERROR: renderCampaignGrid is missing!");
    }
};

window.closeCampaignMap = function() { 
    if(window.Sound) window.Sound.click();
    document.getElementById("campaign-modal")?.classList.add("hidden"); 
    
    // 🟢 THE FIX: Gagamitin na rin natin ang Hard Reload Protocol kapag umalis sa Map!
    window.goHome(true); 
};

// 3. START LEVEL BUTTON (Planet Click)
window.startCampaignLevel = function(levelNum) {
    console.log("SYSTEM: Deploying to Sector " + levelNum);
    if(window.Sound) window.Sound.click();
    
    // Isara ang map at menu
    document.getElementById("campaign-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.add("hidden");

    // I-set ang game mode
    state.gameMode = 'campaign';
    state.currentCampaignLevel = levelNum;

    // Smart Difficulty Scaling (Depende sa Sector)
    if (levelNum <= 20) {
        state.difficulty = 'easy'; 
        state.selectedOps = ['+', '-'];
    } else if (levelNum <= 50) {
        state.difficulty = 'medium'; 
        state.selectedOps = ['x', '÷'];
    } else if (levelNum <= 80) {
        state.difficulty = 'hard'; 
        state.selectedOps = ['+', '-', 'x', '÷'];
    } else {
        state.difficulty = 'hard'; 
        state.selectedOps = ['Alg']; // Boss/God Levels = Algebra
    }

    // Bibilis ang kalaban habang tumataas ang level
    let baseSpawn = state.difficulty === 'easy' ? 3000 : (state.difficulty === 'hard' ? 1800 : 2500);
    state.spawnRate = Math.max(800, baseSpawn - (levelNum * 15)); 

    console.log(`Setting up Game | Diff: ${state.difficulty} | Rate: ${state.spawnRate}`);

    // Umpisahan ang laro
    if(typeof startGameLogic === "function") {
        startGameLogic();
    } else {
        console.error("CRITICAL ERROR: startGameLogic function is missing!");
    }
};

// ==========================================
// 🌌 ALL-IN-ONE CAMPAIGN & LOOT MASTER CONTROLLER
// ==========================================

// 1. OPEN / CLOSE MAP
window.openCampaignMap = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("start-modal").classList.add("hidden");
    document.getElementById("campaign-modal").classList.remove("hidden");
    window.renderCampaignGrid(); // Auto-draw the map when opened
};

window.closeCampaignMap = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("campaign-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.remove("hidden");
};

// 2. SIDEBAR MILESTONE UPDATER
window.updateMilestoneSidebar = function(currentLevel) {
    let nextSupply = Math.ceil(currentLevel / 5) * 5;
    if (nextSupply === currentLevel) nextSupply += 5; 
    if (nextSupply > 100) nextSupply = 100;
    
    let supplyText = currentLevel > 100 ? "ALL CLEARED" : `Clear Level ${nextSupply}`;
    const nsTextObj = document.getElementById("next-supply-text");
    if(nsTextObj) nsTextObj.innerText = supplyText;

    const artifacts = [30, 50, 70, 100];
    artifacts.forEach(lvl => {
        let card = document.getElementById(`art-${lvl}`);
        if (card) {
            if (currentLevel > lvl) { 
                card.classList.remove("locked");
                card.classList.add("unlocked");
                let imgBox = card.querySelector('.art-img-box');
                if(imgBox) imgBox.innerHTML = "✔️";
            } else {
                card.classList.add("locked");
                card.classList.remove("unlocked");
                let imgBox = card.querySelector('.art-img-box');
                if(imgBox) imgBox.innerHTML = "🔒";
            }
        }
    });
};

// 3. AAA CIRCUIT MAP GENERATOR
window.renderCampaignGrid = function() {
    const grid = document.getElementById("campaign-grid");
    const svgPath = document.getElementById("map-path-layer");
    const scrollArea = document.getElementById("map-scroll-area");
    const viewport = document.getElementById("map-viewport");
    
    if (!grid || !svgPath || !scrollArea || !viewport) return;
    
    grid.innerHTML = ""; svgPath.innerHTML = "";
    
    let myProgress = (currentUser && currentUser.campaignChapter) ? currentUser.campaignChapter : 1;
    let myStars = (currentUser && currentUser.campaignStars) ? currentUser.campaignStars : {};

    let percent = Math.min(100, ((myProgress - 1) / 100) * 100);
    const percText = document.getElementById("campaign-percentage");
    const percFill = document.getElementById("campaign-fill");
    if(percText) percText.innerText = Math.round(percent) + "%";
    if(percFill) percFill.style.width = percent + "%";

    let totalStars = 0;
    Object.values(myStars).forEach(stars => { totalStars += stars; });
    const starDisplay = document.getElementById("total-stars-display");
    if(starDisplay) starDisplay.innerText = totalStars;

    const nodeSpacingX = 180; 
    const startOffsetX = 100;
    const totalWidth = startOffsetX + (100 * nodeSpacingX) + 400; 
    
    scrollArea.style.width = totalWidth + "px";
    svgPath.style.width = totalWidth + "px";
    svgPath.style.height = "100%";

    const mapHeight = viewport.clientHeight || 600; 
    let previousX = null; let previousY = null; let targetScrollX = 0; 
    const yPatterns = [50, 25, 75, 35, 65, 20, 80, 45, 55, 50];

    for (let i = 1; i <= 100; i++) {
        let xPosPx = startOffsetX + ((i - 1) * nodeSpacingX); 
        let yPosPercent = yPatterns[(i - 1) % yPatterns.length];
        let yPosPx = (yPosPercent / 100) * mapHeight; 

        if (previousX !== null && previousY !== null) {
            let path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            let midX = (previousX + xPosPx) / 2;
            let d = `M ${previousX} ${previousY} L ${midX} ${previousY} L ${midX} ${yPosPx} L ${xPosPx} ${yPosPx}`;
            path.setAttribute("d", d);
            path.setAttribute("class", `circuit-line ${i <= myProgress ? 'cleared' : 'locked'}`);
            svgPath.appendChild(path);
        }

        previousX = xPosPx; previousY = yPosPx;

        let isBoss = (i % 10 === 0);
        let isSupply = (i % 5 === 0 && !isBoss);
        let nodeTypeClass = "node-normal";
        let innerText = i;
        
        if (isBoss) { nodeTypeClass = "node-boss"; innerText = "☠️"; } 
        else if (isSupply) { nodeTypeClass = "node-supply"; innerText = "<span>🎁</span>"; }

        let node = document.createElement("div");
        node.className = `c-node ${nodeTypeClass}`;
        node.style.left = `${xPosPx}px`; node.style.top = `${yPosPx}px`;

        let starsCount = myStars[i] || 0;
        
        if (i < myProgress) {
            node.classList.add("cleared");
            let starsHTML = "⭐".repeat(starsCount) + "<span style='opacity:0.2'>" + "⭐".repeat(3 - Math.max(0, starsCount)) + "</span>";
            node.innerHTML = `${innerText}<div class="node-stars">${starsHTML}</div>`;
            node.onclick = () => window.startCampaignLevel(i);
        } else if (i === myProgress) {
            node.classList.add("unlocked");
            node.innerHTML = `<div class="circuit-ship">🚀</div>${innerText}`;
            node.onclick = () => window.startCampaignLevel(i);
            targetScrollX = xPosPx; 
        } else {
            node.classList.add("locked");
            node.innerHTML = isBoss ? "🔒" : innerText;
            node.style.opacity = "0.4";
            node.onclick = () => { if(window.Sound) window.Sound.error(); };
        }
        // ... (Ito yung lumang part na nag-aassign kung locked o cleared ang node) ...

        // 🟢 IDAGDAG ITO BAGO ANG: grid.appendChild(node);
        // HOVER INTEL LOGIC (The Wow Factor)
        node.addEventListener('mouseenter', (e) => {
            window.showSectorIntel(e, i, myProgress, starsCount);
        });
        
        node.addEventListener('mouseleave', () => {
            const tooltip = document.getElementById("map-tooltip");
            if(tooltip) {
                tooltip.classList.remove("visible");
                setTimeout(() => tooltip.classList.add("hidden"), 200); // delay para smooth mawala
            }
        });

    
        grid.appendChild(node);
    }

    window.updateMilestoneSidebar(myProgress);

    // UX: Drag to scroll
    let isDown = false; let startX; let scrollLeft;
    viewport.addEventListener('mousedown', (e) => {
        isDown = true; viewport.style.cursor = 'grabbing';
        startX = e.pageX - viewport.offsetLeft; scrollLeft = viewport.scrollLeft;
    });
    viewport.addEventListener('mouseleave', () => { isDown = false; viewport.style.cursor = 'grab'; });
    viewport.addEventListener('mouseup', () => { isDown = false; viewport.style.cursor = 'grab'; });
    viewport.addEventListener('mousemove', (e) => {
        if (!isDown) return; e.preventDefault();
        const walk = (e.pageX - viewport.offsetLeft - startX) * 1.5; 
        viewport.scrollLeft = scrollLeft - walk;
    });

    viewport.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) { e.preventDefault(); viewport.scrollLeft += e.deltaY; }
    }, { passive: false });

    setTimeout(() => {
        viewport.scrollTo({ left: targetScrollX - (viewport.clientWidth / 2) + 150, behavior: "smooth" });
    }, 500);
};

// 4. LEVEL STARTER LOGIC
window.startCampaignLevel = function(levelNum) {
    if(window.Sound) window.Sound.click();
    document.getElementById("campaign-modal").classList.add("hidden");
    document.getElementById("start-modal").classList.add("hidden");

    state.gameMode = 'campaign';
    state.currentCampaignLevel = levelNum;

    // Adaptive Difficulty
    if (levelNum <= 20) { state.difficulty = 'easy'; state.selectedOps = ['+', '-']; } 
    else if (levelNum <= 50) { state.difficulty = 'medium'; state.selectedOps = ['x', '÷']; } 
    else if (levelNum <= 80) { state.difficulty = 'hard'; state.selectedOps = ['+', '-', 'x', '÷']; } 
    else { state.difficulty = 'hard'; state.selectedOps = ['Alg']; }

    let baseSpawn = state.difficulty === 'easy' ? 3000 : (state.difficulty === 'hard' ? 1800 : 2500);
    state.spawnRate = Math.max(800, baseSpawn - (levelNum * 15)); 

    if(typeof startGameLogic === "function") startGameLogic();
};

// 5. REWARDS & GACHA SYSTEM
window.proceedCampaignVictory = async function() {
    document.getElementById("win-modal").classList.add("hidden");

    let lvl = window.pendingRewardLevel;
    window.pendingRewardLevel = null; 

    if (lvl) {
        if (lvl === 30) return await window.showRewardModal('artifact', 'PHANTOM SHIP', '🥷', 'turret_phantom', 0);
        if (lvl === 50) return await window.showRewardModal('artifact', 'AEGIS CRUISER', '🛡️', 'turret_aegis', 0);
        if (lvl === 70) return await window.showRewardModal('artifact', 'DARK MATTER DRIVE', '🌌', 'fx_void', 0);
        if (lvl === 100) return await window.showRewardModal('artifact', 'GOD-CORE', '👁️', 'turret_god', 0);

        if (lvl % 5 === 0) {
            let coinPrize = lvl * 50; 
            return await window.showRewardModal('supply', 'SECTOR CACHE', '📦', null, coinPrize);
        }
    }
    window.openCampaignMap();
};

window.showRewardModal = async function(type, title, icon, itemToUnlock, coinsGiven) {
    if(window.Sound) window.Sound.playBGM('intro'); 
    
    const modal = document.getElementById("reward-modal");
    const glowBox = document.getElementById("reward-icon-container");
    
    document.getElementById("reward-title").innerText = type === 'artifact' ? "ARTIFACT ACQUIRED!" : "SUPPLY SECURED!";
    document.getElementById("reward-icon").innerText = icon;
    
    if (type === 'artifact') {
        document.getElementById("reward-name").innerText = title;
        document.getElementById("reward-desc").innerText = "CLASSIFIED SKIN ADDED TO ARMORY.";
        glowBox.className = "reward-glow-box artifact-glow"; 
        
        if (currentUser && !currentUser.inventory.includes(itemToUnlock)) {
            currentUser.inventory.push(itemToUnlock);
        }
    } else {
        document.getElementById("reward-name").innerText = `+${coinsGiven} COINS`;
        document.getElementById("reward-desc").innerText = title;
        glowBox.className = "reward-glow-box"; 
        state.coins += coinsGiven;
    }

    if (currentUser && currentUser.uid) {
        await updateDoc(doc(db, "users", currentUser.uid), {
            inventory: currentUser.inventory,
            coins: state.coins
        });
    }

    modal.classList.remove("hidden");
};

window.closeRewardModal = function() {
    if(window.Sound) window.Sound.click();
    document.getElementById("reward-modal").classList.add("hidden");
    window.openCampaignMap();
};

// 6. INJECT SECRET SKINS TO SHOP CATALOG (IF NOT YET ADDED)
if (typeof shopCatalog !== 'undefined') {
    if (!shopCatalog.ships.some(s => s.id === 'turret_phantom')) {
        shopCatalog.ships.push({ id: 'turret_phantom', subtype: 'turret', name: 'Phantom', price: 'LOCKED', img: 'ship_default.png', desc: 'Campaign Lvl 30 Reward.' });
        shopCatalog.ships.push({ id: 'turret_aegis', subtype: 'turret', name: 'Aegis', price: 'LOCKED', img: 'ship_default.png', desc: 'Campaign Lvl 50 Reward.' });
        shopCatalog.ships.push({ id: 'turret_god', subtype: 'turret', name: 'N.E.X.U.S. Core', price: 'LOCKED', img: 'ship_default.png', desc: 'Campaign Lvl 100 Reward.' });
        shopCatalog.fx.push({ id: 'fx_void', name: 'Dark Matter', price: 'LOCKED', color: '#b000ff', aura: 'void', desc: 'Campaign Lvl 70 Reward.' });
    }
}

// ==========================================
// 🛸 SECTOR INTEL (HOLOGRAPHIC TOOLTIP LOGIC)
// ==========================================
window.showSectorIntel = function(event, level, currentProgress, stars) {
    if(window.Sound) window.Sound.playTone(1500, 'sine', 0.02); // Cute cyber blip sound pag tinutok!

    const tooltip = document.getElementById("map-tooltip");
    if(!tooltip) return;

    // 1. Determine Sector & Math Logic
    let sectorName = ""; let topic = ""; let tColor = "";
    if (level <= 20) { sectorName = "OUTER RIM"; topic = "Addition & Subtraction"; tColor = "#00ff41"; }
    else if (level <= 50) { sectorName = "THE GRID"; topic = "Multiplication & Division"; tColor = "#ffd700"; }
    else if (level <= 80) { sectorName = "THE VOID"; topic = "Mixed Integers (+/-)"; tColor = "#ff0055"; }
    else { sectorName = "NEXUS CORE"; topic = "Algebraic Variables"; tColor = "#b000ff"; }

    // 2. Identify Node Type (Boss, Supply, Normal)
    let typeName = "NORMAL COMBAT";
    let typeColor = "#aaa";
    if (level % 10 === 0) { typeName = "☠️ SECTOR GUARDIAN"; typeColor = "#ff0055"; }
    else if (level % 5 === 0) { typeName = "🎁 SUPPLY CACHE"; typeColor = "#ffd700"; }

    // 3. Evaluate Player Progress
    let statusText = ""; let statusColor = ""; let starHTML = "";
    if (level < currentProgress) {
        statusText = "CLEARED"; statusColor = "#00ff41";
        starHTML = "⭐".repeat(stars) + "<span style='opacity:0.3'>" + "⭐".repeat(3 - stars) + "</span>";
    } else if (level === currentProgress) {
        statusText = "ACTIVE TARGET"; statusColor = "#00e5ff";
        starHTML = "NO DATA";
    } else {
        statusText = "LOCKED"; statusColor = "#555";
        starHTML = "CLASSIFIED";
        topic = "DATA ENCRYPTED"; // Itago ang topic kung di pa naa-unlock
    }

    // 4. Inject Data into HTML
    document.getElementById("tt-lvl").innerText = `LVL ${level}`;
    document.getElementById("tt-type").innerText = typeName;
    document.getElementById("tt-type").style.color = typeColor;
    
    document.getElementById("tt-sector").innerText = sectorName;
    document.getElementById("tt-sector").style.color = tColor;
    
    document.getElementById("tt-topic").innerText = `MISSION: ${topic}`;
    
    document.getElementById("tt-status").innerText = statusText;
    document.getElementById("tt-status").style.color = statusColor;
    document.getElementById("tt-stars").innerHTML = starHTML;

    // Dynamic border color
    tooltip.style.borderColor = tColor;

    // 5. Position the Tooltip exactly above the planet being hovered
    const rect = event.target.getBoundingClientRect();
    tooltip.style.left = rect.left + (rect.width / 2) + "px";
    tooltip.style.top = rect.top + "px";

    // Show with animation
    tooltip.classList.remove("hidden");
    // Small delay to allow CSS transition to kick in
    setTimeout(() => tooltip.classList.add("visible"), 10);
};


// ==========================================
// 🛡️ N.E.X.U.S. V6: TITAN AUTO-CORRECT MATRIX (MASSIVE TYPO HANDLER)
// ==========================================
window.nexusAutoCorrect = {
    // Math Concepts & Misspellings
    "aljebra": "algebra", "algeba": "algebra", "algbra": "algebra", "algerba": "algebra", 
    "addishun": "addition", "adition": "addition", "plus": "addition", "add": "addition", 
    "subtrak": "subtraction", "minus": "subtraction", "subtrac": "subtraction",
    "multyply": "multiplication", "multiply": "multiplication", "times": "multiplication", "multi": "multiplication",
    "divishun": "division", "devision": "division", "divide": "division", "div": "division",
    "pemdas": "pemdas", "bodmas": "pemdas", "order of operations": "pemdas",
    "fruction": "fraction", "fracshun": "fraction", "frac": "fraction", "praksyon": "fraction",
    "numirator": "numerator", "numerater": "numerator", "taas": "numerator",
    "denomenator": "denominator", "dinominator": "denominator", "ilalim": "denominator",
    "decimel": "decimal", "desimal": "decimal", "dot": "decimal",
    "prsent": "percentage", "percent": "percentage", "porsyento": "percentage",
    "jeometry": "geometry", "geomtry": "geometry", "jomtry": "geometry",
    "ariel": "area", "areah": "area", "aria": "area",
    "piramiter": "perimeter", "perimetar": "perimeter",
    "bolyum": "volume", "volum": "volume",
    "sirkol": "circle", "cerkel": "circle", "circl": "circle", "bilog": "circle",
    "reyjus": "radius", "radus": "radius", "kalahati ng bilog": "radius",
    "dayameter": "diameter", "diametar": "diameter",
    "sirkumperens": "circumference", "circumferance": "circumference",
    "pi": "pi", "pie": "pi", "3.14": "pi",
    "trayanggulo": "triangle", "triangl": "triangle", "tryangle": "triangle",
    "iskwer": "square", "skwer": "square", "sqare": "square",
    "rektanggel": "rectangle", "rectangl": "rectangle",
    "paytagorean": "pythagorean", "pythagoras": "pythagorean", "pitagoras": "pythagorean",
    "haypotenus": "hypotenuse", "hypotnuse": "hypotenuse", "hipotenuse": "hypotenuse",
    "trigo": "trigonometry", "trigonometre": "trigonometry",
    "sayn": "sine", "sin": "sine",
    "cowsign": "cosine", "cosin": "cosine", "cos": "cosine",
    "tanjent": "tangent", "tan": "tangent",
    "calc": "calculus", "kalculus": "calculus", "kalkyulus": "calculus",
    "deribativ": "derivative", "derive": "derivative",
    "intejer": "integer", "intiger": "integer", "whole number": "integer",
    "iksponent": "exponent", "power": "exponent",
    "baryabol": "variable", "varable": "variable",
    "ekwasyon": "equation", "equasion": "equation",
    "praym": "prime", "pryme": "prime",
    "meydib": "median", "midyan": "median",
    "mowd": "mode", "mod": "mode",
    "prabability": "probability", "prob": "probability",
    "vektor": "vector", "vectr": "vector",
    "simetri": "symmetry", "symetry": "symmetry",
    // Game Concepts & Queries
    "bos": "boss", "monster": "boss", "kalaban": "boss", "mothership": "boss",
    "emp": "emp", "nuke": "emp", "bomba": "emp", "sabog": "emp",
    "sloy": "slow", "bagal": "slow", "freeze": "slow",
    "glitch": "glitch", "bug": "glitch",
    "lore": "lore", "kwento": "lore", "story": "lore",
    "istats": "status", "stat": "status", "skor": "status",
    "wiknes": "weakness", "weaknes": "weakness", "hina": "weakness", "mali": "weakness",
    "difisile": "difficult", "dificult": "difficult", "hirap": "hard", "mahirap": "hard"
};

// Auto-Correct Function
window.sanitizeQuery = function(rawText) {
    let words = rawText.toLowerCase().replace(/[?!.,;'"]/g, '').split(/\s+/);
    for (let i = 0; i < words.length; i++) {
        if (window.nexusAutoCorrect[words[i]]) words[i] = window.nexusAutoCorrect[words[i]];
    }
    return words.join(" ");
};

// =========================================
// 🧠 JESSBOT: ANALYTICS & TACTICAL ADVISOR
// =========================================

window.toggleNexusTerminal = function() {
    if(window.Sound) window.Sound.playTone(1000, 'sine', 0.05);
    const sidebar = document.getElementById("jessbot-sidebar");
    
    if (!sidebar) {
        console.error("JESSBOT SIDEBAR NOT FOUND!");
        return;
    }
    
    const isClosed = sidebar.classList.contains('closed');
    sidebar.classList.toggle('closed');
    
    if (isClosed) {
        window.appendNexusMessage('ai', `Commander ${currentUser ? currentUser.username : ''}, I am tactical advisor V7. Select an operation for analysis.`);
    }

    // 🟢 INSTANT HIDE/SHOW ANG ORB!
    if(window.updateOrbsVisibility) window.updateOrbsVisibility();
};


 




// 2. GINAWANG window. function PARA WALANG "ALREADY DECLARED" ERROR
window.appendNexusMessage = function(sender, text) {
    const history = document.getElementById("nexus-chat-history");
    if(!history) return;
    const msgDiv = document.createElement("div");
    msgDiv.className = sender === 'user' ? "data-block user-block" : "data-block ai-block";
    msgDiv.innerHTML = `<span class="block-label">${sender === 'user' ? 'COMMANDER // INPUT' : 'JESSBOT // SYSTEM'}</span><span class="msg-text">${text}</span>`;
    history.appendChild(msgDiv);
    history.scrollTop = history.scrollHeight;
};







// 🟢 THE FIX: Anti-Spam Locking Mechanism
window.isJessBotTyping = false;

window.executeJessBotCommand = async function(commandType) {
    if (window.isJessBotTyping) return; // 🛡️ I-block kung nagsasalita pa si Jessbot!
    if(window.Sound) window.Sound.click();
    
    window.isJessBotTyping = true; // 🔒 I-lock ang system

    let userText = "";
    if (commandType === 'analyze') userText = "Analyze my latest mission data.";
    if (commandType === 'status') userText = "Provide overall system status.";
    if (commandType === 'weakness') userText = "Identify my mathematical weaknesses.";
    if (commandType === 'tip') userText = "Requesting tactical combat advice.";
    
    window.appendNexusMessage('user', userText);

    const historyBox = document.getElementById("nexus-chat-history");
    const waveform = document.getElementById("ai-waveform");
    if(waveform) waveform.classList.remove("hidden");
    historyBox.scrollTop = historyBox.scrollHeight;

    await new Promise(resolve => setTimeout(resolve, 1500)); // Fake processing

    let finalResponse = "";

    if (!currentUser) {
        finalResponse = "⚠️ ERROR: No Agent profile detected. Please login to access analytics.";
    } 
    else {
        let history = currentUser.matchHistory || [];
        
        switch (commandType) {
            case 'analyze':
                if (history.length === 0) {
                    finalResponse = "No combat data found. Engage the enemy first, Commander.";
                } else {
                    let lastGame = history[history.length - 1];
                    let accColor = lastGame.accuracy >= 80 ? "highlight-green" : (lastGame.accuracy >= 50 ? "highlight-gold" : "highlight-red");
                    let evalText = lastGame.accuracy >= 80 ? "Outstanding performance. Combat ready." : "Sub-optimal. Additional training required.";
                    
                    finalResponse = `
                        Report compiled. Analyzing latest deployment...
                        <div class="ai-readout">
                            <b>MODE:</b> ${lastGame.mode.toUpperCase()}<br>
                            <b>OPERATION:</b> ${lastGame.operation ? lastGame.operation.toUpperCase() : 'MIXED'}<br>
                            <b>SCORE:</b> ${lastGame.score}<br>
                            <b>EFFICIENCY:</b> <span class="${accColor}">${lastGame.accuracy}%</span>
                        </div>
                        <br><i>Conclusion:</i> ${evalText}
                    `;
                }
                break;

            case 'status':
                // 🌟 AAA IMPROVEMENT: LIVE COMBAT STATUS!
                if (state.isPlaying) {
                    let hpColor = state.health > 50 ? "highlight-green" : "highlight-red";
                    finalResponse = `
                        <span style="color:#ff0055;" class="blink">🔴 LIVE COMBAT DETECTED</span><br><br>
                        <div class="ai-readout">
                            <b>THREAT LEVEL:</b> LVL ${state.level}<br>
                            <b>HULL INTEGRITY:</b> <span class="${hpColor}">${state.health}%</span><br>
                            <b>CURRENT SCORE:</b> ${state.score}<br>
                            <b>ACTIVE COMBO:</b> x${state.combo}
                        </div>
                        <br>Stay focused, Commander. Do not let the Nullifiers breach the line!
                    `;
                } else {
                    let totalMissions = history.length;
                    let totalScore = history.reduce((sum, match) => sum + match.score, 0);
                    let avgAcc = totalMissions > 0 ? Math.round(history.reduce((sum, match) => sum + match.accuracy, 0) / totalMissions) : 0;
                    let rank = getRankInfo(currentUser.totalXP || 0).title;
                    let accColorStatus = avgAcc >= 80 ? "highlight-green" : (avgAcc >= 50 ? "highlight-gold" : "highlight-red");

                    finalResponse = `
                        Compiling global telemetry...
                        <div class="ai-readout">
                            <b>AGENT:</b> ${currentUser.username}<br>
                            <b>CURRENT RANK:</b> <span class="highlight-gold">${rank}</span><br>
                            <b>TOTAL MISSIONS:</b> ${totalMissions}<br>
                            <b>LIFETIME EFFICIENCY:</b> <span class="${accColorStatus}">${avgAcc}%</span><br>
                            <b>TOTAL CREDITS:</b> ${state.coins} 🪙
                        </div>
                    `;
                }
                break;

            case 'weakness':
                if (!state.mistakes || state.mistakes.length === 0) {
                    finalResponse = "I am currently tracking 0 tactical errors in your active session. Your logic is flawless.";
                } else {
                    let errMap = { '+': 0, '-': 0, 'x': 0, '÷': 0, 'Alg': 0 };
                    state.mistakes.forEach(m => { 
                        let str = m.q.toString();
                        if(str.includes('x') && str.includes('=')) errMap['Alg']++;
                        else if(str.includes('+')) errMap['+']++; 
                        else if(str.includes('-')) errMap['-']++; 
                        else if(str.includes('x')) errMap['x']++; 
                        else if(str.includes('÷')) errMap['÷']++; 
                    });
                    
                    let weakOp = Object.keys(errMap).reduce((a, b) => errMap[a] > errMap[b] ? a : b);
                    let topic = weakOp === '+' ? "Addition" : weakOp === '-' ? "Subtraction" : weakOp === 'x' ? "Multiplication" : weakOp === '÷' ? "Division" : "Algebra";
                    let mistakeCount = errMap[weakOp];

                    finalResponse = `
                        Scanning active session logs...
                        <div class="ai-readout" style="border-color: #ff0055;">
                            <b>PRIMARY VULNERABILITY:</b> <span class="highlight-red">${topic.toUpperCase()}</span><br>
                            <b>ERRORS DETECTED:</b> ${mistakeCount}
                        </div>
                        <br>Recommend visiting the JESSBOOK to review protocols on ${topic}.
                    `;
                }
                break;

            case 'tip':
                const tips = [
                    "Remember PEMDAS: Multiplication and Division happen before Addition and Subtraction.",
                    "If a target drops a supply crate, prioritize it. It may contain EMP or Slow abilities.",
                    "In Algebra, what you do to one side of the equation, you must do to the other.",
                    "A negative number multiplied by a negative number ALWAYS results in a positive number.",
                    "Check your radar. Team operations require constant communication."
                ];
                let randomTip = tips[Math.floor(Math.random() * tips.length)];
                finalResponse = `💡 <b>TACTICAL TIP:</b><br><br><i>"${randomTip}"</i>`;
                break;
        }
    }

    if(waveform) waveform.classList.add("hidden");
    window.typewriteNexusMessage(finalResponse);
};

window.typewriteNexusMessage = function(htmlContent) {
    const history = document.getElementById("nexus-chat-history");
    if(!history) return;
    const msgDiv = document.createElement("div");
    msgDiv.className = "data-block ai-block";
    msgDiv.style.borderColor = "#ffd700";
    
    msgDiv.innerHTML = `<span class="block-label" style="color: #ffd700;">JESSBOT // SYSTEM</span><span class="msg-text"></span>`;
    history.appendChild(msgDiv);
    
    const textSpan = msgDiv.querySelector('.msg-text');
    let i = 0;
    let isTag = false;
    let currentHTML = "";
    
    function typeChar() {
        if (i < htmlContent.length) {
            let char = htmlContent.charAt(i);
            currentHTML += char;
            textSpan.innerHTML = currentHTML + "<span class='type-cursor'></span>"; 
            
            if (char === '<') isTag = true;
            if (char === '>') isTag = false;
            i++;
            
            if (!isTag && i % 2 === 0 && window.Sound && !window.Sound.isMuted) {
                window.Sound.playTone(Math.random() * 200 + 1000, 'sine', 0.01);
            }
            history.scrollTop = history.scrollHeight;
            setTimeout(typeChar, isTag ? 0 : 5); 
        } else {
            textSpan.innerHTML = currentHTML; 
            if(window.Sound) window.Sound.playTone(1500, 'square', 0.1); 
            window.isJessBotTyping = false; // 🔓 I-unlock na ulit para makapag-click
        }
    }
    typeChar();
};




// ==========================================
// 🐾 PET COMBAT AI & HELPERS (PHASE 3)
// ==========================================

window.getCurrentPet = function() {
    if (!state.equipped || !state.equipped.pet) return null;
    let allPets = [
        ...petCatalog.common, ...petCatalog.rare, 
        ...petCatalog.epic, ...petCatalog.legendary, ...petCatalog.mythic
    ];
    return allPets.find(p => p.id === state.equipped.pet);
};

// 🐾 THE ORBITAL STRIKE VISUALS (PET ATTACK)
window.petAutoFire = function() {
    if (!state.isPlaying || state.isPaused || state.meteors.length === 0) return;
    
    // Hanapin ang pinakamababang kalaban
    let targets = state.meteors.filter(m => !m.isBoss && !m.isSupply).sort((a, b) => b.y - a.y);
    if (targets.length > 0) {
        let target = targets[0];
        let idx = state.meteors.indexOf(target);
        
        // KUNIN ANG KULAY NG PET
        let myPet = window.getCurrentPet();
        let pColor = "#00e5ff"; // Default Rare
        if (myPet) {
            if(myPet.rarity === 'Epic') pColor = "#b000ff";
            if(myPet.rarity === 'Legendary') pColor = "#ffd700";
            if(myPet.rarity === 'Mythic') pColor = "#ff0055";
        }

        // PANGMALAKASANG LASER EFFECTS
        let petX = (window.canvas.width / 2) + 140; // Tinatayang pwesto ng pet
        let petY = window.canvas.height - 180;
        
        // Spiral Beam
        state.lasers.push({ 
            x1: petX - 20, y1: petY, 
            x2: target.x, y2: target.y, 
            life: 1.2, isAlly: false, color: "white" 
        });
        state.lasers.push({ 
            x1: petX + 20, y1: petY, 
            x2: target.x, y2: target.y, 
            life: 1.2, isAlly: false, color: pColor 
        });

        // Floating Text Combo Hype
        state.floatingTexts.push({ 
            x: target.x, y: target.y - 60, 
            text: `🔥 ${myPet.name.toUpperCase()} STRIKE!`, 
            color: pColor, life: 2.0 
        });
        
        createParticles(target.x, target.y, pColor, 50); // Massive explosion
        if(window.Sound) window.Sound.laser();
        
        // Screen Shake
        state.shake = 15;
        
        destroyMeteor(target, idx);
    }
};

// ==========================================
// 🌌 THE N.E.X.U.S. CORE MATRIX (AAA BACKGROUND)
// ==========================================
const bgCanvas = document.getElementById("bgCanvas");
const bgCtx = bgCanvas ? bgCanvas.getContext("2d") : null;

let nexusNodes = [];
let mouse = { x: -1000, y: -1000, radius: 200 };

window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
});
window.addEventListener('mouseout', () => {
    mouse.x = -1000;
    mouse.y = -1000;
});

const mathSymbols = ['∫', '∑', 'π', 'Δ', 'Ω', '∞', 'θ', 'λ', 'x²', '√'];

class NexusNode {
    constructor() {
        this.x = Math.random() * window.innerWidth;
        this.y = Math.random() * window.innerHeight;
        this.vx = (Math.random() - 0.5) * 0.3; // Very smooth, slow drift
        this.vy = (Math.random() - 0.5) * 0.3;
        this.baseRadius = Math.random() * 2 + 1;
        this.radius = this.baseRadius;
        // 15% chance na Math Symbol, 85% chance na Data Dot
        this.symbol = Math.random() > 0.85 ? mathSymbols[Math.floor(Math.random() * mathSymbols.length)] : null;
        this.color = Math.random() > 0.8 ? '#ffd700' : '#00e5ff'; // Konting gold spots
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;

        // Infinite wrap-around (Pag lumabas sa kanan, lalabas sa kaliwa)
        if (this.x < 0) this.x = window.innerWidth;
        if (this.x > window.innerWidth) this.x = 0;
        if (this.y < 0) this.y = window.innerHeight;
        if (this.y > window.innerHeight) this.y = 0;

        // Mouse interaction (Nodes glow and expand slightly when mouse is near)
        let dx = mouse.x - this.x;
        let dy = mouse.y - this.y;
        let dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < mouse.radius) {
            this.radius = this.baseRadius + 2;
        } else {
            this.radius = this.baseRadius;
        }
    }

    draw(ctx) {
        ctx.beginPath();
        if (this.symbol) {
            ctx.font = "14px 'Orbitron'";
            ctx.fillStyle = this.color;
            ctx.globalAlpha = 0.4;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(this.symbol, this.x, this.y);
        } else {
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = this.color;
            ctx.globalAlpha = 0.5;
            ctx.fill();
        }
        ctx.globalAlpha = 1.0;
    }
}

window.initNexusGrid = function() {
    if (!bgCanvas) return;
    bgCanvas.width = window.innerWidth;
    bgCanvas.height = window.innerHeight;
    
    nexusNodes = [];
    // Dynamic scaling based on screen size (prevent lag on phones)
    let numNodes = Math.floor((window.innerWidth * window.innerHeight) / 12000); 
    if (numNodes > 150) numNodes = 150; // Cap at 150 nodes for performance

    for (let i = 0; i < numNodes; i++) {
        nexusNodes.push(new NexusNode());
    }
};

window.drawNexusGrid = function() {
    // 🛑 WAG I-DRAW KAPAG NASA LOOB NA NG LABAN (Performance Saver)
    if (!bgCtx || state.isPlaying) {
        requestAnimationFrame(window.drawNexusGrid);
        return; 
    }

    // Deep Space Gradient Background
    let bgGrad = bgCtx.createRadialGradient(window.innerWidth/2, window.innerHeight/2, window.innerHeight*0.1, window.innerWidth/2, window.innerHeight/2, window.innerWidth);
    bgGrad.addColorStop(0, "#050a15");
    bgGrad.addColorStop(1, "#010205");
    
    bgCtx.fillStyle = bgGrad;
    bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);

    // Draw Mouse Glow Aura
    if (mouse.x > 0) {
        let mouseGlow = bgCtx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 250);
        mouseGlow.addColorStop(0, "rgba(0, 229, 255, 0.08)");
        mouseGlow.addColorStop(1, "transparent");
        bgCtx.fillStyle = mouseGlow;
        bgCtx.beginPath(); bgCtx.arc(mouse.x, mouse.y, 250, 0, Math.PI*2); bgCtx.fill();
    }

    // Process all nodes
    for (let i = 0; i < nexusNodes.length; i++) {
        let node = nexusNodes[i];
        node.update();
        node.draw(bgCtx);

        // Network Lines (Connect nearby nodes)
        for (let j = i; j < nexusNodes.length; j++) {
            let other = nexusNodes[j];
            let dx = node.x - other.x;
            let dy = node.y - other.y;
            let dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < 120) {
                bgCtx.beginPath();
                bgCtx.strokeStyle = node.color;
                bgCtx.globalAlpha = 0.2 - (dist / 120) * 0.2; // Fade out line based on distance
                bgCtx.lineWidth = 1;
                bgCtx.moveTo(node.x, node.y);
                bgCtx.lineTo(other.x, other.y);
                bgCtx.stroke();
                bgCtx.globalAlpha = 1.0;
            }
        }

        // Mouse Connection Lines (Tactical Laser Scan Effect)
        let mdx = node.x - mouse.x;
        let mdy = node.y - mouse.y;
        let mDist = Math.sqrt(mdx * mdx + mdy * mdy);

        if (mDist < 180) {
            bgCtx.beginPath();
            bgCtx.strokeStyle = "#ffd700"; // Gold laser pointing to mouse
            bgCtx.globalAlpha = 0.4 - (mDist / 180) * 0.4;
            bgCtx.lineWidth = 1.5;
            bgCtx.moveTo(node.x, node.y);
            bgCtx.lineTo(mouse.x, mouse.y);
            bgCtx.stroke();
            bgCtx.globalAlpha = 1.0;
            
            // Subtle magnetic pull (Parang kinukuha ng mouse yung data)
            node.x -= mdx * 0.015;
            node.y -= mdy * 0.015;
        }
    }
    
    requestAnimationFrame(window.drawNexusGrid);
};

// Initialize
window.addEventListener('load', () => {
    setTimeout(() => {
        window.initNexusGrid();
        window.drawNexusGrid(); 
    }, 500); // Small delay to let CSS load first
});
window.addEventListener('resize', window.initNexusGrid);

// =========================================
// 🧮 N.E.X.U.S. TACTICAL SOLVER ENGINE
// =========================================

// Tab Switcher Logic
window.switchNexusTab = function(tabName) {
    if(window.Sound) window.Sound.click();
    
    // Reset buttons
    document.getElementById("tab-btn-jessbot").style.color = "#888";
    document.getElementById("tab-btn-jessbot").classList.remove("active");
    document.getElementById("tab-btn-solver").style.color = "#888";
    document.getElementById("tab-btn-solver").classList.remove("active");

    // Hide all views
    document.getElementById("nexus-view-jessbot").classList.add("hidden");
    document.getElementById("nexus-view-solver").classList.add("hidden");

    // Show active tab
    if (tabName === 'jessbot') {
        document.getElementById("tab-btn-jessbot").style.color = "#ffd700";
        document.getElementById("tab-btn-jessbot").classList.add("active");
        document.getElementById("nexus-view-jessbot").classList.remove("hidden");
    } else {
        document.getElementById("tab-btn-solver").style.color = "#00e5ff";
        document.getElementById("tab-btn-solver").classList.add("active");
        document.getElementById("nexus-view-solver").classList.remove("hidden");
    }
};

// =========================================
// 🧮 N.E.X.U.S. TACTICAL SOLVER (V4.1 TITANIUM)
// =========================================

// Helper Function: Greatest Common Divisor
function getGCD(a, b) { return b === 0 ? Math.abs(a) : getGCD(b, a % b); }

// Helper: Rounds numbers neatly to 4 decimal places
function roundClean(num) { return Math.round(num * 10000) / 10000; }

window.runTacticalSolver = function() {
    if(window.Sound) window.Sound.click();
    const inputEl = document.getElementById("solver-input");
    const outputBox = document.getElementById("solver-output");
    
    let rawQuery = inputEl.value.trim().toLowerCase();
    
    // 🛡️ THE NORMALIZER V4.1 (Anti-Crash Protocol)
    let query = rawQuery.replace(/\s+/g, ''); // Remove all spaces
    query = query.replace(/÷/g, '/');
    query = query.replace(/×/g, '*');
    query = query.replace(/−/g, '-'); // Unicode minus to standard dash
    query = query.replace(/²/g, '^2');
    query = query.replace(/³/g, '^3');
    
    // Fix implicit multiplications: e.g. 2(3) -> 2*(3) or (2)(3) -> (2)*(3)
    query = query.replace(/(\d)\(/g, "$1*(");
    query = query.replace(/\)(\d)/g, ")*$1");
    query = query.replace(/\)\(/g, ")*(");
    
    if (!query) return;

    outputBox.innerHTML = `<div style="color: #00e5ff; font-family:'Orbitron'; text-align:center; padding: 20px;" class="blink">SCANNING EQUATION DATA...</div>`;
    inputEl.value = ""; 
    
    setTimeout(() => {
        outputBox.innerHTML = ""; 
        let steps = []; 
        let stepCount = 1;
        steps.push(`<span style="color:#fff; font-family:'Orbitron';">TARGET LOCK: ${rawQuery.toUpperCase()}</span>`);

        // --- MODULE 1: SAFETY CHECKS ---
        let openCount = (query.match(/\(/g) || []).length;
        let closeCount = (query.match(/\)/g) || []).length;
        if (openCount !== closeCount) {
            steps.push(`<span class="step-label" style="color:#ff0055;">SYNTAX ERROR:</span> Unbalanced Parentheses detected.`);
            steps.push(`Missing opening or closing bracket. Cannot proceed with decryption.`);
            renderSteps(steps, outputBox);
            return;
        }

        if (query.includes('/0')) {
            steps.push(`<span class="step-label" style="color:#ff0055;">CRITICAL ANOMALY:</span> Division by Zero detected.`);
            steps.push(`Mathematical laws prohibit dividing by zero. Fabric of space-time would collapse.`);
            steps.push(`<span style="color:#ff0055; font-size:16px;">FINAL DECRYPTION: UNDEFINED</span>`);
            renderSteps(steps, outputBox);
            return;
        }

        // --- 🧬 MODULE 2: REGEX PATTERN DETECTION ---
        const nPat = "(-?\\d*\\.?\\d*)"; 
        
        // Quad: ax^2 + bx + c = 0
        let quadRegex = new RegExp(`^${nPat}\\*?x\\^2([+-]?\\d*\\.?\\d*)\\*?x([+-]?\\d*\\.?\\d+)=0$`);
        
        // Linear: ax + b = c (b is now optional!)
        let algRegex = /^(-?\d*\.?\d*)\*?x([+-]\d*\.?\d+)?=(-?\d*\.?\d+)$/;
        
        // Fraction: a/b + c/d
        let fracRegex = /^(-?\d+\.?\d*)\/(\d+\.?\d*)([+-/*^])(-?\d+\.?\d*)\/(\d+\.?\d*)$/;

        let quadMatch = query.match(quadRegex);
        let algMatch = query.match(algRegex);
        let fracMatch = query.match(fracRegex);

        // --- EXECUTE QUADRATIC LOGIC ---
        if (quadMatch) {
            steps.push(`<span class="step-label">ANALYSIS:</span> Quadratic Anomaly Detected. Deploying Quadratic Formula.`);
            let parseCoeff = (val) => {
                if (!val || val === "+") return 1;
                if (val === "-" || val === "-1") return -1;
                return parseFloat(val);
            };
            let a = parseCoeff(quadMatch[1]);
            let b = parseCoeff(quadMatch[2]);
            let c = parseFloat(quadMatch[3]);

            steps.push(`<span class="step-label">STEP 1:</span> Extract Coefficients.<br> a = ${a}, b = ${b}, c = ${c}`);
            let discriminant = (b * b) - (4 * a * c);
            steps.push(`<span class="step-label">STEP 2:</span> Calculate Discriminant (Δ = b² - 4ac).<br> Δ = (${b})² - 4(${a})(${c}) = ${roundClean(discriminant)}`);

            if (discriminant < 0) {
                steps.push(`<span class="step-label" style="color:#ff0055;">ERROR:</span> Negative discriminant. No real solutions.`);
            } else {
                steps.push(`<span class="step-label">STEP 3:</span> Apply base formula: x = [-b ± √Δ] / 2a`);
                let root = Math.sqrt(discriminant);
                let x1 = (-b + root) / (2 * a);
                let x2 = (-b - root) / (2 * a);
                steps.push(`x₁ = ( ${-b} + ${roundClean(root)} ) / ${2*a}`);
                steps.push(`x₂ = ( ${-b} - ${roundClean(root)} ) / ${2*a}`);
                steps.push(`ROOTS IDENTIFIED.`);
                steps.push(`<span style="color:#fff;">x = ${roundClean(x1)}</span>  OR  <span style="color:#fff;">x = ${roundClean(x2)}</span>`);
            }
        } 
        // --- 🟢 EXECUTE LINEAR ALGEBRA LOGIC (FIXED) ---
        else if (algMatch) {
            steps.push(`<span class="step-label">ANALYSIS:</span> Linear Shield Detected. Objective: Isolate x.`);
            
            let aStr = algMatch[1];
            let a = (aStr === "" || aStr === "+") ? 1 : (aStr === "-" ? -1 : parseFloat(aStr));
            let b = algMatch[2] ? parseFloat(algMatch[2]) : 0;
            let c = parseFloat(algMatch[3]);
            
            let newC = c;

            // Step 1: Move B if it exists
            if (b !== 0) {
                steps.push(`<span class="step-label">STEP 1:</span> Reverse Constant. Move ${algMatch[2]} to the right side.`);
                newC = c - b;
                steps.push(`${a}x = ${c} ${b < 0 ? '+' : '-'} ${Math.abs(b)}`);
                steps.push(`${a}x = ${roundClean(newC)}`);
            }

            // Step 2: Divide by A
            if (a !== 1) {
                steps.push(`<span class="step-label">STEP ${b !== 0 ? '2' : '1'}:</span> Divide by coefficient (${a}).`);
                steps.push(`x = ${roundClean(newC)} / ${a}`);
            }
            
            let finalX = newC / a;
            steps.push(`<br><span style="color:#ffd700; font-size:16px;">FINAL DECRYPTION: x = ${roundClean(finalX)}</span>`);
        }
        // --- EXECUTE FRACTION LOGIC ---
        else if (fracMatch) {
            // (Previous Fraction logic remains intact here...)
            steps.push(`<span class="step-label">ANALYSIS:</span> Fractional Armor Detected.`);
            let num1 = parseFloat(fracMatch[1]); let den1 = parseFloat(fracMatch[2]);
            let op = fracMatch[3];
            let num2 = parseFloat(fracMatch[4]); let den2 = parseFloat(fracMatch[5]);

            if (den1 === 0 || den2 === 0) {
                steps.push(`<span class="step-label" style="color:#ff0055;">CRITICAL:</span> Division by Zero.`);
            } else {
                let fNum, fDen;
                if (op === '+' || op === '-') {
                    steps.push(`<span class="step-label">STEP 1:</span> Cross-multiply for Common Denominator.`);
                    fDen = den1 * den2;
                    let top1 = num1 * den2;
                    let top2 = num2 * den1;
                    fNum = op === '+' ? (top1 + top2) : (top1 - top2);
                    steps.push(`Top: ${top1} ${op} ${top2} = ${fNum}`);
                    steps.push(`Bottom: ${den1} * ${den2} = ${fDen}`);
                } 
                else if (op === '*' || op === 'x') {
                    steps.push(`<span class="step-label">STEP 1:</span> Multiply straight across.`);
                    fNum = num1 * num2; fDen = den1 * den2;
                } 
                else if (op === '/') {
                    steps.push(`<span class="step-label">STEP 1:</span> Keep-Change-Flip protocol engaged.`);
                    fNum = num1 * den2; fDen = den1 * num2;
                }

                steps.push(`<span class="step-label">STEP 2:</span> Unsimplified: ${fNum} / ${fDen}`);
                if (Number.isInteger(fNum) && Number.isInteger(fDen)) {
                    let gcd = getGCD(fNum, fDen);
                    if (gcd > 1) {
                        steps.push(`<span class="step-label">STEP 3:</span> Simplifying (Dividing by ${gcd}).`);
                        fNum /= gcd; fDen /= gcd;
                    }
                }
                if (fDen === 1) steps.push(`<br><span style="color:#ffd700; font-size:16px;">RESULT: ${fNum}</span>`);
                else steps.push(`<br><span style="color:#ffd700; font-size:16px;">RESULT: ${fNum} / ${fDen} (or ${roundClean(fNum/fDen)})</span>`);
            }
        }
        // --- ♾️ EXECUTE PEMDAS ARITHMETIC ---
        else {
            // ONLY IF IT'S NOT ALGEBRA: We safely convert remaining 'x' into '*'
            let expr = query.replace(/x/g, '*');
            
            // Check if there are still letters left (meaning it's an unrecognized algebra format)
            if (/[a-wyz]/i.test(expr) || (expr.includes('=') && !expr.includes('=='))) {
                steps.push(`<span class="step-label" style="color:#ff0055;">ERROR:</span> Equation format not recognized.`);
                steps.push(`For variables, only linear (ax+b=c) and quadratic (ax^2+bx+c=0) forms are supported currently.`);
                renderSteps(steps, outputBox);
                return;
            }

            steps.push(`<span class="step-label">ANALYSIS:</span> Complex Mathematical Operation. Engaging PEMDAS sequence.`);
            
            try {
                let sanityCheck = 0;
                while (/[+*/^()]|(?<=\d)-/.test(expr) && sanityCheck < 50) {
                    sanityCheck++; 
                    let nextExpr = expr;
                    let operationDone = "";

                    if (expr.includes('(')) {
                        let match = expr.match(/\(([^()]+)\)/);
                        if (match) {
                            let inner = match[1];
                            if (/^-?\d+\.?\d*$/.test(inner)) {
                                let expMatch = expr.match(new RegExp(`\\(${inner}\\)\\^(-?\\d+\\.?\\d*)`));
                                if(expMatch) {
                                     let res = Math.pow(parseFloat(inner), parseFloat(expMatch[1]));
                                     nextExpr = expr.replace(expMatch[0], roundClean(res));
                                     operationDone = "Process Exponent with parenthetical base.";
                                } else {
                                     nextExpr = expr.replace(match[0], inner);
                                     operationDone = "Remove redundant parentheses.";
                                }
                            } else {
                                let res = evaluateFlat(inner, true); 
                                if(res === "ERROR") throw new Error("Math Error");
                                if(res.newStr !== inner) {
                                    nextExpr = expr.replace(match[0], `(${res.newStr})`);
                                    operationDone = res.action + " (Inside Bracket)";
                                }
                            }
                        }
                    } else {
                        let res = evaluateFlat(expr, true); 
                        if(res === "ERROR") throw new Error("Math Error");
                        if (res.newStr !== expr) {
                            nextExpr = res.newStr;
                            operationDone = res.action;
                        }
                    }

                    if (nextExpr !== expr) {
                        steps.push(`<span class="step-label">STEP ${stepCount++}:</span> ${operationDone}<br> <span style="color:#aaa;">${expr.replace(/\*/g, '×')}</span>  ➔  <span style="color:#fff;">${nextExpr.replace(/\*/g, '×')}</span>`);
                        expr = nextExpr;
                    } else break; 
                }

                let finalAns = parseFloat(expr);
                if (isNaN(finalAns)) throw new Error("NaN");

                steps.push(`<br><span style="color:#ffd700; font-size:16px;">FINAL DECRYPTION: ${roundClean(finalAns)}</span>`);

            } catch (e) {
                steps.push(`<span class="step-label" style="color:#ff0055;">SYSTEM ERROR:</span> Sequence unstable. Check syntax.`);
            }
        }

        renderSteps(steps, outputBox);

    }, 800);
};

// ⚙️ SUB-ENGINE: Flat Evaluator
function evaluateFlat(str, singleStep = false) {
    let expMatch = str.match(/(-?\d+\.?\d*)\^(-?\d+\.?\d*)/);
    if (expMatch) {
        let res = Math.pow(parseFloat(expMatch[1]), parseFloat(expMatch[2]));
        str = str.replace(expMatch[0], roundClean(res));
        if (singleStep) return { newStr: str, action: "Process Exponent." };
    }
    
    str = str.replace(/\+\+/g, '+').replace(/--/g, '+').replace(/\+-/g, '-').replace(/-\+/g, '-');

    let mdMatch = str.match(/(-?\d+\.?\d*)([*/])(-?\d+\.?\d*)/);
    if (mdMatch) {
        let n1 = parseFloat(mdMatch[1]); let op = mdMatch[2]; let n2 = parseFloat(mdMatch[3]);
        if (op === '/' && n2 === 0) return "ERROR";
        let res = op === '*' ? n1 * n2 : n1 / n2;
        str = str.replace(mdMatch[0], roundClean(res));
        if (singleStep) return { newStr: str, action: op === '*' ? "Execute Multiplication." : "Execute Division." };
    }

    str = str.replace(/\+\+/g, '+').replace(/--/g, '+').replace(/\+-/g, '-').replace(/-\+/g, '-');

    let asMatch = str.match(/(-?\d+\.?\d*)([+-])(\d+\.?\d*)/);
    if (asMatch && asMatch[1] !== "") {
        if (asMatch.index === 0 && asMatch[0].match(/^-\d/)) {
            let secMatch = str.substring(asMatch[1].length).match(/([+-])(\d+\.?\d*)/);
            if(secMatch) {
                let n1 = parseFloat(asMatch[1]); let op = secMatch[1]; let n2 = parseFloat(secMatch[2]);
                let res = op === '+' ? n1 + n2 : n1 - n2;
                str = str.replace(asMatch[1] + secMatch[0], roundClean(res));
                if (singleStep) return { newStr: str, action: op === '+' ? "Execute Addition." : "Execute Subtraction." };
            }
        } else {
            let n1 = parseFloat(asMatch[1]); let op = asMatch[2]; let n2 = parseFloat(asMatch[3]);
            let res = op === '+' ? n1 + n2 : n1 - n2;
            str = str.replace(asMatch[0], roundClean(res));
            if (singleStep) return { newStr: str, action: op === '+' ? "Execute Addition." : "Execute Subtraction." };
        }
    }

    return singleStep ? { newStr: str, action: "Complete" } : str;
}

// Animation Renderer Helper
function renderSteps(stepsArray, container) {
    let stepIndex = 0;
    function printNextStep() {
        if (stepIndex < stepsArray.length) {
            let div = document.createElement("div");
            if (stepIndex === stepsArray.length - 1 && !stepsArray[stepIndex].includes("ERROR") && !stepsArray[stepIndex].includes("UNDEFINED")) {
                div.className = "decryption-step final-answer";
                div.innerHTML = "🔓 " + stepsArray[stepIndex];
            } else {
                div.className = "decryption-step";
                div.innerHTML = stepsArray[stepIndex];
            }
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
            if(window.Sound) window.Sound.playTone(800 + (stepIndex * 50), 'square', 0.05); 
            stepIndex++;
            setTimeout(printNextStep, 500); 
        } else {
            if(window.Sound && !stepsArray[stepsArray.length-1].includes("ERROR")) window.Sound.powerup(); 
        }
    }
    printNextStep();
}

// =========================================
// 🔥 OVERDRIVE: 3D PARALLAX VISOR TRACKING
// =========================================

window.addEventListener('mousemove', (e) => {
    // Gumagana lang ang 3D effect kapag buhay ang laro at hindi naka-pause
    if (!state.isPlaying || state.isPaused || state.isGlobalFreeze) {
        let uiLayer = document.getElementById('ui-layer');
        if (uiLayer) uiLayer.style.transform = `none`;
        return;
    }

    // Calculate rotation based on center of the screen
    let centerX = window.innerWidth / 2;
    let centerY = window.innerHeight / 2;
    
    // Sensitivity Multiplier (Lower = subtle, Higher = extreme tilt)
    let sensitivityX = 60; 
    let sensitivityY = 60;

    let rotateX = -(e.clientY - centerY) / sensitivityY;
    let rotateY = (e.clientX - centerX) / sensitivityX;

    // Apply the 3D Tilt to the HUD
    let uiLayer = document.getElementById('ui-layer');
    if (uiLayer) {
        uiLayer.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    }
});

// 🟢 ANTI-CLOAK FAILSAFE: Keep focus on the hidden input box!
document.addEventListener('click', () => {
    if (state.isPlaying && !state.isPaused && !state.isGlobalFreeze) {
        let inputEl = document.getElementById("player-input");
        if (inputEl) inputEl.focus();
    }
});


// ==========================================
// 🔮 HOLOGRAPHIC ORBS VISIBILITY MANAGER (V3 - WITH QUIZ FORGE)
// ==========================================
window.updateOrbsVisibility = function(forceHide = false) {
    const commsBtn = document.getElementById("comms-toggle-btn");
    const jessBtn = document.getElementById("jessbot-toggle-btn");
    const forgeBtn = document.getElementById("quiz-forge-toggle-btn"); // 🟢 TINAWAG NATIN ANG QUIZ ORB

    // 1. INSTANT HIDE OVERRIDE (For Combat)
    if (forceHide) {
        if(commsBtn) commsBtn.style.display = "none";
        if(jessBtn) jessBtn.style.display = "none";
        if(forgeBtn) forgeBtn.style.display = "none";
        return;
    }

    // 2. COMBAT & TEACHER CHECK (Bawal umepal sa laro)
    if (typeof state !== 'undefined' && (state.isPlaying || 
        document.body.classList.contains('in-combat') || 
        document.body.classList.contains('dashboard-active'))) {
        if(commsBtn) commsBtn.style.display = "none";
        if(jessBtn) jessBtn.style.display = "none";
        if(forgeBtn) forgeBtn.style.display = "none";
        return;
    }

    // 3. STORY & INTRO CHECK (Bawal umepal sa cutscenes)
    const bootOverlay = document.getElementById('boot-overlay');
    const introOverlay = document.getElementById('cinematic-intro');
    const storyOverlay = document.getElementById('story-overlay');
    
    if ((bootOverlay && bootOverlay.style.display !== 'none') || 
        (introOverlay && introOverlay.style.display !== 'none') || 
        (storyOverlay && !storyOverlay.classList.contains('hidden'))) {
        if(commsBtn) commsBtn.style.display = "none";
        if(jessBtn) jessBtn.style.display = "none";
        if(forgeBtn) forgeBtn.style.display = "none";
        return;
    }

    // 4. LOGIN SCREEN CHECK (Bawal umepal kung di pa nakapasok)
    const profileSection = document.getElementById('profile-section');
    const isGuestMode = document.getElementById('my-name'); 
    
    if (profileSection && profileSection.classList.contains('hidden') && !isGuestMode) {
        if(commsBtn) commsBtn.style.display = "none";
        if(jessBtn) jessBtn.style.display = "none";
        if(forgeBtn) forgeBtn.style.display = "none";
        return;
    }

    // 🟢 5. SHOW THEM ON DASHBOARD!
    const commsSidebar = document.getElementById("comms-sidebar");
    const jessSidebar = document.getElementById("jessbot-sidebar");

    // Comms Orb Logic
    if (commsSidebar && !commsSidebar.classList.contains("closed")) {
        if(commsBtn) commsBtn.style.display = "none";
    } else {
        if(commsBtn) commsBtn.style.display = "flex";
    }

    // Jessbot & Quiz Forge Logic
    if (jessSidebar && !jessSidebar.classList.contains("closed")) {
        if(jessBtn) jessBtn.style.display = "none";
        if(forgeBtn) forgeBtn.style.display = "none"; // Itago rin ang quiz orb kung bukas ang chat ni jessbot
    } else {
        if(jessBtn) jessBtn.style.display = "flex";
        if(forgeBtn) forgeBtn.style.display = "flex"; // 🟢 DITO SIYA LILITAW!
    }
};

// 🛡️ THE AUTO-WATCHER
if (!window.orbWatcher) {
    window.orbWatcher = setInterval(() => {
        if(typeof window.updateOrbsVisibility === 'function') window.updateOrbsVisibility();
    }, 1000); 
}

// ==========================================================================
// 🧠 N.E.X.U.S. QUIZ FORGE (THE LOGIC ENGINE V2)
// ==========================================================================

// Global state para sa Quiz Forge
window.activeQuizData = [];
window.currentQuizIndex = 0;
window.quizScore = 0;
window.quizMistakes = [];

// 1. MENU CONTROLS
window.openQuizForge = function() {
    if(window.Sound && window.Sound.click) window.Sound.click();
    
    // Itago muna ang Main Menu
    const startModal = document.getElementById("start-modal");
    if(startModal) startModal.classList.add("hidden");
    
    // Ipakita ang Quiz Menu Modal
    const menuModal = document.getElementById("quiz-forge-menu-modal");
    if(menuModal) {
        menuModal.classList.remove("hidden");
        menuModal.style.setProperty('display', 'flex', 'important');
        menuModal.style.setProperty('z-index', '2147483647', 'important');
    }
    
    // Setup empty row for creator if empty
    const list = document.getElementById("qf-creator-list");
    if(list && list.children.length === 0) {
        window.addQuizCreatorRow(); 
    }
};

window.closeQuizForgeMenu = function() {
    if(window.Sound && window.Sound.click) window.Sound.click();
    const menuModal = document.getElementById("quiz-forge-menu-modal");
    if(menuModal) menuModal.classList.add("hidden");
    
    // 🟢 THE FIX: Gumamit na rin ng Hard Reload Protocol (Warp Door)
    if (typeof window.goHome === "function") {
        window.goHome(true);
    } else {
        window.location.reload();
    }
};

window.switchQuizTab = function(tab, event) {
    if(window.Sound && window.Sound.click) window.Sound.click();
    
    // Hide all tabs
    document.querySelectorAll('.quiz-forge-tab').forEach(el => {
        el.classList.add('hidden');
        el.style.display = 'none';
    });
    
    // Remove active class from buttons
    document.querySelectorAll('#quiz-forge-menu-modal .tab-btn').forEach(b => {
        b.classList.remove('active');
    });
    
    // Show selected tab
    const targetTab = document.getElementById(`quiz-tab-${tab}`);
    if(targetTab) {
        targetTab.classList.remove('hidden');
        targetTab.style.display = 'block';
    }
    
    if(event && event.target) {
        event.target.classList.add('active');
    }
};

// 2. AUTO-GENERATOR ALGORITHM (WITH MULTIPLICATION FIX)
window.startAutoQuiz = function() {
    if(window.Sound && window.Sound.powerup) window.Sound.powerup();
    
    const topicEl = document.querySelector('input[name="qf-topic"]:checked');
    const topic = topicEl ? topicEl.value : 'integers';
    
    const digits = parseInt(document.getElementById("qf-digits").value) || 1;
    const count = parseInt(document.getElementById("qf-count").value) || 10;
    
    let ops = [];
    if(document.getElementById("qf-op-add") && document.getElementById("qf-op-add").checked) ops.push('+');
    if(document.getElementById("qf-op-sub") && document.getElementById("qf-op-sub").checked) ops.push('-');
    if(document.getElementById("qf-op-mul") && document.getElementById("qf-op-mul").checked) ops.push('x');
    if(document.getElementById("qf-op-div") && document.getElementById("qf-op-div").checked) ops.push('÷');

    if(ops.length === 0) {
        alert("COMMANDER: Select at least one mathematical operation!");
        return;
    }

    window.activeQuizData = [];
    
    // Number Generator helper
    const getNum = (dig) => {
        let min = dig === 1 ? 1 : Math.pow(10, dig - 1);
        let max = Math.pow(10, dig) - 1;
        let num = Math.floor(Math.random() * (max - min + 1)) + min;
        if (topic === 'integers' && Math.random() < 0.3) num *= -1; // Negative chance for integers
        return num;
    };

    for(let i=0; i<count; i++) {
        let op = ops[Math.floor(Math.random() * ops.length)];
        let q, a;

        if (topic === 'algebra') {
            let x = getNum(1); // 1-digit x para hindi mahirap compute-in
            let c = getNum(digits); // Constant base on digits selected
            
            if (op === '+') { q = `x + ${c} = ${x+c}`; a = x; }
            if (op === '-') { q = `x - ${c} = ${x-c}`; a = x; }
            if (op === 'x') { let co = getNum(1)+1; q = `${co}x = ${co*x}`; a = x; }
            if (op === '÷') { q = `x ÷ 2 = ${x/2}`; a = x; } 
        } else {
            let n1 = getNum(digits);
            let n2 = getNum(digits);
            
            if (op === '+') { 
                q = `${n1} + ${n2}`; a = n1 + n2; 
            }
            if (op === '-') { 
                if (n1 < n2 && topic !== 'integers') { let temp=n1; n1=n2; n2=temp; } 
                q = `${n1} - ${n2}`; a = n1 - n2; 
            }
            if (op === 'x') { 
                // 🟢 REQUESTED FIX: Multiplication logic (1 digit multiplier lang)
                // Kahit 3 digits pa pinili nila, yung pang-multiply (n2) is laging 1 digit!
                n2 = getNum(1); 
                q = `${n1} x ${n2}`; a = n1 * n2; 
            }
            if (op === '÷') {
                let ans = getNum(digits);
                n2 = getNum(1) + 1; // 1-digit divisor
                n1 = ans * n2;
                q = `${n1} ÷ ${n2}`; a = ans;
            }
        }
        window.activeQuizData.push({ q: q, a: a.toString() });
    }

    const titleEl = document.getElementById("qf-play-title");
    if(titleEl) titleEl.innerText = "AUTO-GENERATED DRILL";
    window.launchQuizUI();
};

// 3. GAMEPLAY ENGINE (The Flashcard Loop)
window.launchQuizUI = function() {
    const menuModal = document.getElementById("quiz-forge-menu-modal");
    if(menuModal) menuModal.classList.add("hidden");
    
    const flashModal = document.getElementById("quiz-flashcard-modal");
    if(flashModal) {
        flashModal.classList.remove("hidden");
        flashModal.style.setProperty('display', 'flex', 'important');
        flashModal.style.setProperty('z-index', '2147483647', 'important');
    }
    
    window.currentQuizIndex = 0;
    window.quizScore = 0;
    window.quizMistakes = [];
    
    window.renderCurrentQuestion();
};

window.renderCurrentQuestion = function() {
    if (window.currentQuizIndex >= window.activeQuizData.length) {
        return window.finishQuiz();
    }
    
    let currentQ = window.activeQuizData[window.currentQuizIndex];
    
    const progEl = document.getElementById("qf-play-progress");
    if(progEl) progEl.innerText = `${window.currentQuizIndex + 1} / ${window.activeQuizData.length}`;
    
    const qEl = document.getElementById("qf-play-question");
    if(qEl) qEl.innerText = currentQ.q;
    
    const input = document.getElementById("qf-play-input");
    if(input) {
        input.value = "";
        input.disabled = false;
        input.focus();
    }
    
    const feedbackEl = document.getElementById("qf-play-feedback");
    if(feedbackEl) feedbackEl.innerText = "";
};

window.submitQuizAnswer = function() {
    const input = document.getElementById("qf-play-input");
    if(!input) return;
    
    let userAns = input.value.trim().toLowerCase(); 
    if (userAns === "") return;

    let currentData = window.activeQuizData[window.currentQuizIndex];
    let correctAns = currentData.a.toString().toLowerCase();
    
    const feedbackEl = document.getElementById("qf-play-feedback");

    if (userAns === correctAns) {
        if(window.Sound && window.Sound.laser) window.Sound.laser();
        window.quizScore++;
        if(feedbackEl) {
            feedbackEl.style.color = "#00ff41";
            feedbackEl.innerText = "TARGET DESTROYED!";
        }
    } else {
        if(window.Sound && window.Sound.error) window.Sound.error();
        if(window.triggerDamageGlitch) window.triggerDamageGlitch();
        window.quizMistakes.push({ q: currentData.q, a: currentData.a, wrong: userAns, type: 'wrong' });
        
        if(feedbackEl) {
            feedbackEl.style.color = "#ff0055";
            feedbackEl.innerText = `MISS! CORRECT: ${currentData.a}`;
        }
    }

    input.disabled = true; // Lock briefly so they don't spam
    
    setTimeout(() => {
        window.currentQuizIndex++;
        window.renderCurrentQuestion();
    }, 1000); 
};

window.abortQuiz = function() {
    if(window.Sound && window.Sound.click) window.Sound.click();
    
    if(confirm("ABORT DRILL? No data will be saved.")) {
        // Itago agad ang Flashcard Modal
        const flashModal = document.getElementById("quiz-flashcard-modal");
        if(flashModal) {
            flashModal.classList.add("hidden");
            flashModal.style.setProperty('display', 'none', 'important');
        }
        
        // 🟢 THE FIX: Tawagin ang Master Reload Protocol (Warp Door + Refresh)
        if (typeof window.goHome === "function") {
            window.goHome(true); 
        } else {
            window.location.reload(); // Failsafe
        }
    }
};

window.finishQuiz = function() {
    if(window.Sound && window.Sound.powerup) window.Sound.powerup();
    
    const flashModal = document.getElementById("quiz-flashcard-modal");
    if(flashModal) flashModal.classList.add("hidden");
    
    // Transfer data to the existing Report System!
    if(typeof state !== 'undefined') {
        state.score = window.quizScore * 50; 
        state.mistakes = window.quizMistakes;
        state.gameMode = 'quiz'; // 🟢 SET TO 'quiz' PARA ALAM NG SYSTEM NA NASA FLASHCARDS TAYO
        
        state.gameHistory = window.activeQuizData.map(item => ({
            q: item.q,
            a: item.a,
            status: window.quizMistakes.some(m => m.q === item.q) ? 'wrong' : 'correct'
        }));
        state.maxCombo = window.quizScore; 
    }
    
    const reportModal = document.getElementById("report-modal");
    if(reportModal) {
        reportModal.classList.remove("hidden");
        reportModal.style.setProperty('z-index', '2147483647', 'important');
        reportModal.style.setProperty('display', 'flex', 'important');
        
        // 🟢 FIX: THE SMART RETRY BUTTON LOGIC
        const retryBtn = reportModal.querySelector('button[onclick*="startSolo"]');
        const homeBtn = reportModal.querySelector('button[onclick*="goHome"]');
        const aiBtn = reportModal.querySelector('button[onclick*="startAITraining"]');

        // Setup Retry Button para mag-loop back sa mismong Quiz!
        if (retryBtn) {
            retryBtn.style.display = 'block';
            retryBtn.innerText = "🔄 RETRY QUIZ";
            retryBtn.onclick = function() {
                if(window.Sound && window.Sound.click) window.Sound.click();
                reportModal.classList.add("hidden");
                reportModal.style.setProperty('display', 'none', 'important');
                
                // INSTANT RESTART NG QUIZ!
                window.launchQuizUI();
            };
        }

        // Setup Home Button
        if (homeBtn) {
            homeBtn.style.display = 'block';
            homeBtn.onclick = function() {
                reportModal.classList.add("hidden");
                window.goHome(true); // Tatawagin ang Hard Reload
            };
        }

        // Payagan ang AI Training galing sa Quiz
        if (aiBtn) aiBtn.style.display = 'block';
    }
    
    const repScore = document.getElementById("rep-score");
    if(repScore) repScore.innerText = typeof state !== 'undefined' ? state.score : 0;

    if(typeof window.renderTacticalLog === 'function') window.renderTacticalLog();
    if(typeof window.generateMissionDebrief === 'function') window.generateMissionDebrief();
    if(typeof window.saveMatchRecord === 'function') window.saveMatchRecord();
};


// 4. TEACHER CUSTOM CREATOR LOGIC (AAA REDESIGN)
window.addQuizCreatorRow = function() {
    const list = document.getElementById("qf-creator-list");
    if(!list) return;
    
    if(window.Sound && window.Sound.click) window.Sound.click();

    const div = document.createElement("div");
    div.className = "creator-row";
    // Mala-Holographic Data Block Design
    div.style.cssText = "background: rgba(0, 229, 255, 0.05); border: 1px solid #004455; padding: 15px; margin-bottom: 12px; border-radius: 8px; display: flex; gap: 15px; align-items: center; box-shadow: 0 0 10px rgba(0,0,0,0.5);";
    
    div.innerHTML = `
        <div class="row-num" style="color: #00e5ff; font-family: 'Orbitron'; font-size: 20px; font-weight: bold; width: 30px; text-align: center; text-shadow: 0 0 10px #00e5ff;"></div>
        
        <div style="flex: 2;">
            <label style="font-size: 10px; color: #00e5ff; display: block; margin-bottom: 5px; letter-spacing: 1px;">TARGET EQUATION (Use 'x' for Algebra)</label>
            <input type="text" class="cyber-input q-input" placeholder="e.g. 3x + 5 = 20" style="width: 100%; font-size: 18px; padding: 10px; border: 1px solid #00e5ff; background: #000; color: #fff; border-radius: 4px; box-sizing: border-box;">
        </div>
        
        <div style="flex: 1;">
            <label style="font-size: 10px; color: #ffd700; display: block; margin-bottom: 5px; letter-spacing: 1px;">KEY ANSWER</label>
            <input type="text" class="cyber-input a-input" placeholder="e.g. 5" style="width: 100%; font-size: 18px; padding: 10px; border: 1px solid #ffd700; background: #000; color: #ffd700; text-align: center; border-radius: 4px; box-sizing: border-box;">
        </div>
        
        <button class="btn text-only" style="color: #ff0055; font-size: 24px; padding: 0 10px; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform='scale(1)'" onclick="window.removeQuizRow(this)" title="Delete Row">✖</button>
    `;
    
    list.appendChild(div);
    window.updateQuizRowNumbers();
};

window.removeQuizRow = function(btn) {
    if(window.Sound && window.Sound.error) window.Sound.error();
    btn.parentElement.remove();
    window.updateQuizRowNumbers();
};

window.updateQuizRowNumbers = function() {
    const list = document.getElementById("qf-creator-list");
    if(!list) return;
    const rows = list.querySelectorAll('.creator-row');
    rows.forEach((row, index) => {
        row.querySelector('.row-num').innerText = index + 1;
    });
};

window.saveCustomQuiz = async function() {
    if(typeof currentUser === 'undefined' || !currentUser || typeof db === 'undefined' || !db) {
        return alert("System Offline. Cannot connect to database.");
    }
    
    if(window.Sound && window.Sound.click) window.Sound.click();

    const titleEl = document.getElementById("qf-create-title");
    const title = titleEl ? titleEl.value.trim() : "";
    if(!title) return alert("COMMANDER: Please enter a Quiz Title.");
    
    const list = document.getElementById("qf-creator-list");
    if(!list) return;
    
    const rows = list.children;
    let customData = [];
    
    // Loop through all inputs and save
    for(let i=0; i<rows.length; i++) {
        let qEl = rows[i].querySelector(".q-input");
        let aEl = rows[i].querySelector(".a-input");
        if(qEl && aEl) {
            let q = qEl.value.trim();
            let a = aEl.value.trim();
            if(q && a) customData.push({ q: q, a: a });
        }
    }
    
    if(customData.length === 0) return alert("ERROR: Add at least 1 completed question and answer.");
    
    const code = "QUIZ-" + Math.floor(1000 + Math.random() * 9000);
    
    try {
        const btn = document.querySelector("#quiz-tab-create .primary");
        if(btn) btn.innerText = "UPLOADING...";

        await setDoc(doc(db, "custom_quizzes", code), {
            title: title,
            author: (typeof myName !== 'undefined' ? myName : currentUser.username),
            uid: currentUser.uid,
            questions: customData,
            createdAt: Date.now()
        });
        
        if(window.Sound && window.Sound.powerup) window.Sound.powerup();
        alert(`[ DEPLOYMENT SUCCESS ]\n\nShare this code with your agents to start the drill:\n\n👉 ${code}`);
        
        if(btn) btn.innerText = "💾 SAVE & GENERATE CODE";
        window.closeQuizForgeMenu();
    } catch(e) {
        alert("Error saving: " + e.message);
    }
};

window.joinCustomQuiz = async function() {
    const codeEl = document.getElementById("qf-join-code");
    if(!codeEl) return;
    const code = codeEl.value.trim().toUpperCase();
    if(!code) return;
    
    if(typeof db === 'undefined' || !db) return alert("Database offline.");
    
    try {
        const snap = await getDoc(doc(db, "custom_quizzes", code));
        if (snap.exists()) {
            let data = snap.data();
            window.activeQuizData = data.questions;
            
            const titleEl = document.getElementById("qf-play-title");
            if(titleEl) titleEl.innerText = data.title.toUpperCase();
            
            window.launchQuizUI();
        } else {
            alert("No quiz found with that code.");
        }
    } catch(e) {
        alert("Connection error.");
    }
};

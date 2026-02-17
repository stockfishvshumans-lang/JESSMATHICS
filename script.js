
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, query, orderBy, limit, doc, setDoc, getDoc, onSnapshot, updateDoc } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";
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


// ✅ NEW: Triggered only when clicking "CLASS MODE" if session exists
window.resumeClassSession = function() {
    if (!pendingSessionData) return;

    const data = pendingSessionData;
    console.log("🚀 RESUMING SESSION...", data);

    if (data.role === 'teacher') {
        // --- RESUME TEACHER ---
        window.myName = data.name; 
        document.body.classList.add('dashboard-active'); 
        
        document.getElementById("start-modal").classList.add("hidden");
        
        const dash = document.getElementById("teacher-dashboard");
        if(dash) dash.classList.remove("hidden");
        
        const roomCodeEl = document.getElementById("dash-room-code");
        // Fix double "CLASS-" text if present
        if(roomCodeEl) roomCodeEl.innerText = data.room.replace("CLASS-", "");
        
        currentRoomId = data.room;
        isHost = true;
        state.gameMode = 'classroom';
        window.monitorClassroom(data.room);

    } else if (data.role === 'student') {
        // --- RESUME STUDENT ---
        window.myName = data.name;
        document.body.classList.remove('dashboard-active');
        
        document.getElementById("start-modal").classList.add("hidden");
        
        state.gameMode = 'classroom';
        currentRoomId = data.room;
        isHost = false;
        
        // Re-fetch room data to ensure it still exists
        getDoc(doc(db, "rooms", data.room)).then(snap => {
            if (snap.exists()) {
                const rData = snap.data();
                enterClassroomLobby(data.room, rData.roomName);
            } else {
                alert("Cannot Resume: Class has ended or room invalid.");
                clearSession();
                location.reload();
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
        'city': { src: 'city_bg.png', img: new Image() },
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

// --- UPDATED GAME STATE ---
let state = {
    isPlaying: false, isPaused: false, isGlobalFreeze: false,
    score: 0, totalScore: 0, coins: 200, health: 100,
    level: 1, xp: 0, xpToNext: 50,
    spawnRate: 2500, difficulty: 'medium', selectedOps: ['+'], 
    bossActive: false, bossData: null, shake: 0,
    meteors: [], particles: [], lasers: [], stars: [], buildings: [], 
    nemesisList: [],
    // ✅ FIX: Maglagay ng Default Equipped State
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

    gameHistory: [], 
    
    floatingTexts: [], shockwaves: [],
    lastTime: 0, spawnTimer: 0, scoreSubmitted: false, isSlowed: false,
    gameMode: 'vs', lastSkillTime: 0, 
    opponentState: { meteors: [], lasers: [], health: 100, score: 0 },
    timeRemaining: 120, maxTime: 120, mathCycle: 0, helpRequested: false,
    combo: 0, maxCombo: 0,
    bossAttackState: { charging: false, firing: false, chargeTimer: 0, targetX: 0 },
    training: { active: false, currentQ: null, mistakesFixed: 0 },
    inputLocked: false, lockTimer: 0, classroomTopic: 'all', swarmCount: 12
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
        await setDoc(doc(db, "users", cred.user.uid), {
            username: name.toUpperCase(),
            email: email,
            totalXP: 0,
            rank: "CADET",
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
    location.reload();
};

window.playAsGuest = function() {
    const originalGuestBtn = document.getElementById('guest-option');
    if(originalGuestBtn) originalGuestBtn.classList.add('hidden');

    const authSection = document.getElementById('auth-section');
    authSection.innerHTML = `
        <div id="name-container">
            <input type="text" id="my-name" class="main-input" placeholder="ENTER GUEST NAME" maxlength="10">
        </div>
        
        <button class="btn primary" onclick="window.startSolo()">🚀 SOLO</button>
        <button class="btn secondary" onclick="window.showMultiplayerMenu()">⚔️ MULTIPLAYER</button>
        
        <div style="margin-top: 15px; border-top: 1px solid #333; padding-top: 10px;">
            <button class="btn text-only" onclick="location.reload()">⬅ BACK TO LOGIN</button>
        </div>
    `;
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
                currentUser = docSnap.data();
                currentUser.uid = user.uid;
                myName = currentUser.username; 
                
                document.getElementById('auth-section').classList.add('hidden');
                document.getElementById('guest-option').classList.add('hidden');
                document.getElementById('profile-section').classList.remove('hidden');
                
                const rankData = getRankInfo(currentUser.totalXP);
                document.getElementById('agent-name-display').innerText = myName;
                document.getElementById('rank-title').innerText = rankData.title;
                document.getElementById('rank-icon').innerText = rankData.icon;
                document.getElementById('xp-text').innerText = `${currentUser.totalXP} / ${rankData.next} XP`;
                
                let xpPercent = Math.min(100, (currentUser.totalXP / rankData.next) * 100);
                document.getElementById('profile-xp-fill').style.width = xpPercent + "%";
                
                if(window.Sound) window.Sound.speak("Welcome back, " + myName);
            }
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
    if (state.coins !== hudCache.coins) {
        const elCoins = document.getElementById("coins-txt");
        if(elCoins) elCoins.innerHTML = `${state.coins}`;
        hudCache.coins = state.coins;
    }

    // 3. Update Health OR Timer (PHASE 2 CHANGE)
    if (state.gameMode === 'classroom') {
        // TIMER MODE
        const elHealthBox = document.querySelector("#hud-top .center .hud-box");
        const elLabel = elHealthBox.querySelector(".label");
        const elValue = document.getElementById("health-txt");
        
        if(elLabel) elLabel.innerText = "TIME LEFT";
        
        // Format MM:SS
        let mins = Math.floor(state.timeRemaining / 60);
        let secs = Math.floor(state.timeRemaining % 60);
        let timeStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        
        if(elValue) {
            elValue.innerText = timeStr;
            // Color logic: Yellow if < 30s, Red if < 10s
            elValue.style.color = state.timeRemaining < 10 ? "#ff0055" : (state.timeRemaining < 30 ? "#ffd700" : "#00e5ff");
        }
    } else {
        // NORMAL HEALTH MODE
        const elLabel = document.querySelector("#hud-top .center .hud-box .label");
        if(elLabel) elLabel.innerText = "HEALTH";

        if (state.health !== hudCache.health) {
            const elHealth = document.getElementById("health-txt");
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

window.Sound = {
    ctx: null, isMuted: false,
    init: function() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if(this.ctx.state==='suspended') this.ctx.resume(); },
    toggle: function() { this.isMuted = !this.isMuted; return this.isMuted; },
    speak: function(text) {
        if(this.isMuted || !('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.pitch = 1.2; u.rate = 1.1; 
        const v = window.speechSynthesis.getVoices().find(v => v.name.includes('Zira') || v.name.includes('Female'));
        if(v) u.voice = v;
        window.speechSynthesis.speak(u);
    },
    playTone: function(f,t,d) { if(!this.ctx||this.isMuted)return; try{const o=this.ctx.createOscillator();const g=this.ctx.createGain();o.type=t;o.frequency.value=f;g.gain.value=0.1;g.gain.exponentialRampToValueAtTime(0.01,this.ctx.currentTime+d);o.connect(g);g.connect(this.ctx.destination);o.start();o.stop(this.ctx.currentTime+d);}catch(e){} },
    laser: function() { this.playTone(800,'sine',0.1); }, 
    boom: function() { this.playTone(100,'square',0.3); },
    error: function() { this.playTone(150,'sawtooth',0.2); }, 
    nuke: function() { this.playTone(50,'sawtooth',0.8); }, 
    powerup: function() { this.playTone(1200,'sine',0.4); this.playTone(1500,'sine',0.4); },
    click: function() { this.init(); this.playTone(400,'sine',0.05); }
};

// --- MATH LOGIC (SMART ALGEBRA MODE) ---
// --- MATH LOGIC (SMART ALGEBRA MODE) ---
function generateMath(isHard) {
    let ops = state.selectedOps || ['+'];
    
    // 1. Check if Algebra Mode is Active
    let isAlgebraMode = ops.includes('Alg');
    
    // 2. Determine "Inner" Operations
    // If Alg is selected, we use the OTHER selected ops to build the equation.
    let innerOps = ops.filter(op => op !== 'Alg');
    if (innerOps.length === 0) innerOps = ['+', '-']; 

    // 3. Pick the actual math operation
    let op = innerOps[Math.floor(Math.random() * innerOps.length)];

    // 4. Difficulty Settings
    let currentDiff = state.difficulty;
    let min = 2; 
    let max = 12; // Default limit
    let allowNeg = false;

    if (currentDiff === 'medium') { max = 20; allowNeg = Math.random() < 0.3; }
    if (currentDiff === 'hard') { max = 30; allowNeg = Math.random() < 0.5; }
    if (state.gameMode === 'classroom' && state.classroomTopic === 'integers') { allowNeg = true; max = 25; }

    const getNum = (mn, mx, neg) => {
        let n = Math.floor(Math.random() * (mx - mn + 1)) + mn;
        if (neg && Math.random() > 0.5) n *= -1;
        return n === 0 ? 1 : n; 
    };

    let n1 = getNum(min, max, allowNeg);
    let n2 = getNum(min, max, allowNeg);

    // 5. Generate Question
    if (isAlgebraMode) {
        // --- ALGEBRA LOGIC: 3x = 12, x + 5 = 10 ---
        let x = n1; // This is the ANSWER the user must type
        let constant = n2;
        let result;
        let equation = "";

        switch (op) {
            case '+': 
                // x + 5 = 15
                result = x + constant;
                equation = `x + ${constant} = ${result}`; 
                if(constant < 0) equation = `x - ${Math.abs(constant)} = ${result}`;
                break;
            case '-':
                // x - 5 = 10
                result = x - constant;
                equation = `x - ${constant} = ${result}`;
                if(constant < 0) equation = `x + ${Math.abs(constant)} = ${result}`;
                break;
            case 'x':
                // 3x = 12 (We make 'constant' the coefficient)
                constant = getNum(2, 9, allowNeg); 
                x = getNum(2, 12, allowNeg);
                result = constant * x;
                equation = `${constant}x = ${result}`;
                break;
            case '÷':
                // x / 5 = 2. User types 10.
                let answer = getNum(2, 12, allowNeg);
                constant = Math.abs(getNum(2, 9, false));
                x = answer; 
                result = answer; 
                equation = `x ÷ ${constant} = ${constant}`; // x / 2 = 2? No wait.
                // Correction: x / constant = result.
                // if x=10, const=2, result=5.
                // equation: x / 2 = 5.
                result = getNum(2, 10, allowNeg);
                x = result * constant;
                equation = `x ÷ ${constant} = ${result}`;
                break;
        }
        return { q: equation, a: x };

    } else {
        // --- STANDARD ARITHMETIC LOGIC ---
        switch (op) {
            case '+': return { q: `${n1} + ${n2}`, a: n1 + n2 };
            case '-': return { q: `${n1} - ${n2}`, a: n1 - n2 };
            case 'x': 
                n1 = getNum(2, 12, allowNeg); n2 = getNum(2, 9, allowNeg);
                return { q: `${n1} x ${n2}`, a: n1 * n2 };
            case '÷': 
                n2 = Math.abs(n2); if(n2 < 2) n2 = 2;
                let ans = Math.abs(getNum(2, 12, false));
                let dividend = n2 * ans;
                if (allowNeg && Math.random() > 0.5) { dividend *= -1; ans *= -1; }
                return { q: `${dividend} ÷ ${n2}`, a: ans };
            default: return { q: `${n1} + ${n2}`, a: n1 + n2 };
        }
    }
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
// --- SOCKET LOGIC (UPDATED WITH XP SYNC & FIXES) ---
if(socket) {
    socket.on('connect', () => { 
        if(myName) socket.emit('register_player', myName); 
    });

    // 1. VS MODE STATE SYNC
    socket.on('receive_vs_state', (oppState) => { 
        if (state.gameMode === 'vs') {
            state.opponentState = oppState; 
            
            // 🚨 FIX: Auto-Detect Win Condition (0 HP Spy)
            if (state.isPlaying && !state.isPaused && oppState.health <= 0) {
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
    
    // 6. PARTY MODE: XP SYNC (HOST SIDE)
    // Host receives XP gain from Client -> Adds to total -> Broadcasts back
    socket.on('client_xp_gain', (data) => {
        if (state.gameMode === 'party' && isHost) {
            state.xp += data.amount; // Add Client's contribution
            checkLevelUp(); 
            updateHUD();
            
            // 🚨 NEW: Broadcast updated Total XP back to everyone
            socket.emit('host_sync_xp', { room: currentRoomId, xp: state.xp, maxXp: state.xpToNext });
        }
    });

    // 7. PARTY MODE: XP SYNC (CLIENT SIDE)
    // Client receives total XP from Host
    socket.on('sync_xp_update', (data) => {
        if (state.gameMode === 'party' && !isHost) {
            state.xp = data.xp;
            state.xpToNext = data.maxXp; 
            updateHUD(); // Bar moves visually
        }
    });

    // 8. SKILLS & EXTRAS
    socket.on('sync_skill', (data) => {
        if (state.gameMode === 'party' && state.isPlaying) {
            if (data.type === 'EMP') triggerEMP(true, true); 
            if (data.type === 'SLOW') triggerSlowMo(true, true);
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
    // SECURITY CHECK: If frozen by teacher, student cannot resume
    if (state.isGlobalFreeze) {
        if(window.Sound) window.Sound.error();
        return; 
    }

    if(!state.isPlaying) return; 
    state.isPaused = !state.isPaused; 
    
    let m = document.getElementById("pause-modal"); 
    let title = document.getElementById("pause-title");
    let btn = document.getElementById("btn-resume-game");

    if(state.isPaused) { 
        m.classList.remove("hidden"); 
        // Default text for manual pause
        if(title) title.innerText = "SYSTEM PAUSED";
        if(btn) btn.style.display = "block"; // Ensure button is visible
        if(window.inputField) window.inputField.blur(); 
    } else { 
        m.classList.add("hidden"); 
        if(window.inputField) window.inputField.focus(); 
        state.lastTime = performance.now(); 
        requestAnimationFrame(gameLoop); 
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
    myName = nameVal; if(socket) socket.emit('register_player', myName); return true;
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
};

// 2. UNIVERSAL "GO HOME" / LOGOUT (The Nuclear Option)
window.goHome = function() {
    if(window.Sound) window.Sound.click();
    
    // Check if we need to confirm
    if (state.isPlaying && !confirm("ABORT MISSION? Progress will be lost.")) {
        return;
    }

    // If Student or Teacher, CLEAR SESSION so they don't auto-rejoin on reload
    // This fixes the "Loop" issue
    if (sessionStorage.getItem('jess_session')) {
        clearSession();
    }

    // Force Reload to clear all game states/canvas/memory
    location.reload(); 
};

window.abortStudent = function() {
    if(confirm("Disconnect from Classroom?")) {
        window.goHome(); // Reuse the secure logic
    }
};
window.confirmMission = async function() {
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

window.goHome = function() { location.reload(); };

window.joinRoom = async function() {
    const codeInput = document.getElementById("join-code-input");
    const code = codeInput.value.toUpperCase().trim();
    if(code.length < 4) return alert("Invalid Room Code");
    if(!window.validateName()) return; 

    try {
        const roomRef = doc(db, "rooms", code);
        const roomSnap = await getDoc(roomRef);
        
        if(!roomSnap.exists()) return alert("Room not found!");
        const roomData = roomSnap.data();
        
        if (roomData.mode === 'classroom') {
            state.gameMode = 'classroom';
            currentRoomId = code;
            isHost = false;
            
            // 🚨 FIX: Determine ID Once
            myDocId = currentUser ? currentUser.uid : myName;
            
            const studentRef = doc(db, "rooms", code, "students", myDocId);
            
            // 🚨 FIX: Added 'totalScore: 0' immediately
            await setDoc(studentRef, {
                name: myName, 
                status: 'online', 
                currentScore: 0, 
                totalScore: 0, // IMPORTANT
                accuracy: 100, 
                joinedAt: new Date()
            }, { merge: true }); 

            saveSession('student', code, myName, myDocId);

            if(roomData.config) {
                state.difficulty = roomData.config.difficulty;
                state.classroomTopic = roomData.config.topic; 
                if (roomData.config.ops) state.selectedOps = roomData.config.ops;
            }
            enterClassroomLobby(code, roomData.roomName);
        } else {
            // Multiplayer logic (Unchanged)
            state.gameMode = roomData.mode || 'party';
            isHost = false;
            if (roomData.settings) {
                state.selectedOps = roomData.settings.ops;
                state.difficulty = roomData.settings.diff;
            }
            let newPlayers = roomData.players || [];
            if (!newPlayers.some(p => p.name === myName)) {
                newPlayers.push({name: myName});
                await updateDoc(roomRef, { players: newPlayers });
            }
            myPlayerIndex = newPlayers.length - 1; 
            currentRoomId = code; 
            enterLobbyUI(code);
            if(socket) socket.emit('join_room', { room: code, name: myName });
        }
    } catch(e) { console.error(e); alert("Error joining room: " + e.message); }
};

function enterClassroomLobby(code, roomName) {
    // 1. UI Setup
    document.getElementById("mp-menu-modal").classList.add("hidden");
    document.getElementById("lobby-modal").classList.remove("hidden");
    document.getElementById("room-code-display").innerText = roomName || code;
    document.getElementById("lobby-title-text").innerText = "CLASSROOM STANDBY";
    document.getElementById("client-wait-msg").classList.remove("hidden");
    document.getElementById("client-wait-msg").innerText = "EYES ON THE TEACHER...";
    document.getElementById("host-start-btn").classList.add("hidden"); 

    if (roomUnsub) roomUnsub();
    
    roomUnsub = onSnapshot(doc(db, "rooms", code), (snap) => {
        if(!snap.exists()) {
            alert("Classroom disbanded.");
            window.goHome();
            return;
        }
        
        const data = snap.data();

        // Config Sync
        if(data.config) {
            if(data.config.ops) state.selectedOps = data.config.ops;
            state.classroomTopic = data.config.topic || 'custom';
            state.customTimeLimit = data.config.timeLimit; 
        }

        // --- SIGNAL: START / RESUME ---
        if (data.status === 'playing') {
            
            // A. RESUME FROM FREEZE (Wag galawin ang score)
            if(state.isPaused && state.isGlobalFreeze) {
                 console.log("Resuming from freeze...");
                 state.isGlobalFreeze = false;
                 state.isPaused = false;
                 document.getElementById("pause-modal").classList.add("hidden");
                 
                 const resumeBtn = document.getElementById("btn-resume-game");
                 if(resumeBtn) resumeBtn.style.display = 'block';
                 
                 requestAnimationFrame(gameLoop);
                 if(window.inputField) window.inputField.focus();
                 return; 
            }

            // B. NEW ROUND START logic
            if (!state.isPlaying || (state.roundsPlayed !== data.currentRound)) {
                console.log("Starting Round:", data.currentRound);
                document.getElementById("report-modal").classList.add("hidden");
                document.getElementById("lobby-modal").classList.add("hidden");
                
                state.gameMode = 'classroom'; 
                state.roundsPlayed = data.currentRound || 1; 

                // 🚨 CUMULATIVE SCORE FIX 🚨
                // Reset lang ang Score at Mistakes kapag Round 1.
                // Kapag Round 2+, ituloy lang ang current value.
                if (state.roundsPlayed === 1) {
                    state.score = 0;
                    state.mistakes = []; 
                }

                // Reward: Always Full Health sa simula ng Round
                state.health = 100;     
                
                // Clear Enemies
                state.meteors = [];
                state.lasers = [];
                state.particles = [];
                
                startGameLogic(); 
                reportProgress(false); 
            }
        }

        // --- SIGNAL: FREEZE ---
        if (data.status === 'frozen' && state.isPlaying) {
            state.isPaused = true;
            state.isGlobalFreeze = true;
            document.getElementById("pause-modal").classList.remove("hidden");
            
            const pauseTitle = document.querySelector("#pause-modal h2");
            if(pauseTitle) {
                pauseTitle.innerText = "⚠️ FROZEN BY COMMANDER";
                pauseTitle.style.color = "#ff0055";
            }
            
            const resumeBtn = document.getElementById("btn-resume-game");
            if(resumeBtn) resumeBtn.style.display = 'none';
            if(window.inputField) window.inputField.blur();
        }

        // --- SIGNAL: INTERMISSION (Round Ended) ---
        if (data.status === 'round_ended' && state.isPlaying) {
            state.isPlaying = false;
            if(window.inputField) window.inputField.blur();
            
            if (typeof scoreInterval !== 'undefined') clearInterval(scoreInterval);
            if (state.gameTimer) clearInterval(state.gameTimer);

            // Note: Hindi na natin kailangan i-add sa totalScore variable kasi
            // ang state.score mismo ay cumulative na.
            
            const reportModal = document.getElementById("report-modal");
            reportModal.classList.remove("hidden");
            
            const rTitle = document.querySelector("#report-modal h1");
            const scoreLabel = document.querySelector("#report-modal small");
            
            if(rTitle) {
                rTitle.innerText = "ROUND COMPLETE";
                rTitle.className = "neon-blue"; 
                rTitle.style.color = "#00e5ff";
            }
            if(scoreLabel) scoreLabel.innerText = "TOTAL SCORE (SO FAR)";
            
            // Show Cumulative Score
            document.getElementById("rep-score").innerText = state.score;
            
            const retryBtn = reportModal.querySelector('button[onclick*="startSolo"]');
            const homeBtn = reportModal.querySelector('button[onclick*="goHome"]');
            
            if(homeBtn) homeBtn.style.display = 'none'; 
            if(retryBtn) { 
                retryBtn.innerText = "⏳ WAITING FOR NEXT ROUND..."; 
                retryBtn.style.opacity = "0.8"; 
                retryBtn.disabled = true;
                retryBtn.style.display = "block";
                retryBtn.onclick = null;
            }

            reportProgress(false);
        }

        // --- SIGNAL: FINISHED (Game Over) ---
        if (data.status === 'finished') {
            state.isPlaying = false;
            if (typeof scoreInterval !== 'undefined') clearInterval(scoreInterval);
            if (state.gameTimer) clearInterval(state.gameTimer);
            
            const reportModal = document.getElementById("report-modal");
            if(reportModal) {
                reportModal.classList.remove("hidden");
                const title = reportModal.querySelector("h1");
                const scoreLabel = document.querySelector("#report-modal small");
                
                if(title) {
                    title.innerText = "MISSION ACCOMPLISHED";
                    title.className = "neon-gold"; 
                    title.style.color = "#ffd700";
                }
                if(scoreLabel) scoreLabel.innerText = "FINAL MISSION SCORE";
                
                // Final Score is just state.score (Cumulative)
                document.getElementById("rep-score").innerText = state.score;
                
                const retryBtns = document.querySelector(".retry-actions");
                if(retryBtns) {
                    retryBtns.innerHTML = `<button class="btn primary" onclick="window.goHome()">LOGOUT AGENT</button>`;
                }
            }
            reportProgress(true);
        }
    });
}

function enterLobbyUI(code) {
    document.getElementById("mp-menu-modal").classList.add("hidden"); document.getElementById("lobby-modal").classList.remove("hidden");
    document.getElementById("room-code-display").innerText = code;
    let titleEl = document.getElementById("lobby-title-text");
    if(titleEl) titleEl.innerText = state.gameMode === 'party' ? "TEAM LOBBY" : "VS LOBBY";
    if(isHost) document.getElementById("host-start-btn").classList.remove("hidden"); else document.getElementById("client-wait-msg").classList.remove("hidden");
    roomUnsub = onSnapshot(doc(db, "rooms", code), (snap) => {
        if(!snap.exists()) return;
        let data = snap.data(); totalPlayers = data.players.length; 
        let list = document.getElementById("lobby-players"); 
        if(list) { list.innerHTML=""; data.players.forEach(p => list.innerHTML += `<div class="lobby-player-row"><span>${p.name}</span></div>`); }
        if(data.gameState === 'playing' && !state.isPlaying) startGameLogic();
    });
}
window.hostStartGame = async function() { if(totalPlayers < 2) { alert("Need 2 players!"); return; } await updateDoc(doc(db, "rooms", currentRoomId), { gameState: 'playing' }); };

function startGameLogic() {
    // 1. Reset Combo & Visuals
    state.combo = 0; state.maxCombo = 0;
    const comboEl = document.getElementById("combo-container");
    if(comboEl) comboEl.classList.add("hidden");

    if (!window.canvas) window.canvas = document.getElementById("gameCanvas");
    if (!window.ctx && window.canvas) window.ctx = window.canvas.getContext("2d");

    // 2. CLASSROOM MODE: COUNTDOWN START
    // Ito ang tamang logic: Magbibilang muna bago mag-start.
    if (state.gameMode === 'classroom') {
        const countEl = document.getElementById('start-countdown');
        
        if(countEl) {
            countEl.innerText = "3";
            countEl.classList.remove('hidden');
            
            let count = 3;
            if(window.Sound) window.Sound.click();

            let startInterval = setInterval(() => {
                count--;
                if(count > 0) {
                    countEl.innerText = count;
                    if(window.Sound) window.Sound.click();
                } else if (count === 0) {
                    countEl.innerText = "GO!";
                    if(window.Sound) window.Sound.powerup();
                } else {
                    // Start The Actual Game Loop
                    clearInterval(startInterval);
                    countEl.classList.add('hidden');
                    beginGameplay(); // <--- DITO MAGSISIMULA ANG LARO
                }
            }, 1000);
            return; // Stop here, wait for countdown
        }
    }

    // 3. SOLO/VS MODE: Start Immediately
    beginGameplay();
}

function beginGameplay() {
    if (window.Sound) { window.Sound.init(); window.Sound.speak(state.gameMode === 'vs' ? "Versus Mode!" : "Mission Start!"); }
    
    state.isPlaying = true; state.isPaused = false; 
    
    // 🚨 FIX 1: RESET SCORE ONLY (Huwag i-reset ang coins!)
    // Kung Class Mode, pwede i-reset ang score, pero sa Survival/Solo, coins must persist.
    if(state.gameMode !== 'classroom' || state.roundsPlayed === 1) { 
        state.score = 0; 
        state.mistakes = []; 
        state.gameHistory = []; 
    }
    
    // 🚨 FIX 2: LOAD UPGRADE STATS
    // Sa halip na 'state.health = 100', tinatawag natin ang calculator
    if (window.applyUpgradeStats) {
        window.applyUpgradeStats(); // Ito ang magse-set ng Health to 110, 120, etc.
    } else {
        state.health = 100; // Fallback kung walang shop logic
    }

    // Reset Level Progression (In-game lang ito, hindi user rank)
    state.level = 1; state.xp = 0; state.xpToNext = 50; 
    
    // ✅ PHASE 3.5: CUSTOM TIMER SETUP
    if (state.gameMode === 'classroom') {
        // Default to 120s if no config found
        state.timeRemaining = state.customTimeLimit || 120; 
        
        // Global Game Timer Loop
        if(state.gameTimer) clearInterval(state.gameTimer);
        state.gameTimer = setInterval(() => {
            if(!state.isPaused && state.isPlaying) {
                state.timeRemaining--;
                updateHUD();
                if(state.timeRemaining <= 0) {
                    clearInterval(state.gameTimer);
                    gameOver();
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
    
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    if(window.inputField) { window.inputField.value = ""; window.inputField.focus(); }
    
    // Update HUD immediately to reflect new Health/Coins
    if(window.updateHUD) updateHUD();
    
    state.lastTime = performance.now(); state.spawnTimer = performance.now();
    if(window.fetchTopAgents) fetchTopAgents();

    if(state.gameMode === 'solo' || isHost || state.gameMode === 'vs') { spawnMeteor(0,0,false); }
    
    if(state.gameMode === 'vs' && socket && currentRoomId) {
        setInterval(() => {
            if(state.isPlaying && !state.isPaused) {
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
        }, 50); 
    }

    if (state.gameMode === 'classroom') {
        if (typeof scoreInterval !== 'undefined' && scoreInterval) clearInterval(scoreInterval);
        scoreInterval = setInterval(reportProgress, 3000); 
    }
    requestAnimationFrame(gameLoop);
}

function spawnMeteor(x, y, isBossSource) {
    if (state.bossActive && !isBossSource) return;

    // --- BOSS SPAWN LOGIC (Unchanged) ---
    if ((state.level % 5 === 0) && !state.bossActive && !isBossSource && state.level > 1) {
        state.bossActive = true;
        let bossHP = 30 + (state.level * 5);
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
            window.Sound.speak("Warning. Massive Object Detected.");
            window.Sound.playTone(50, 'sawtooth', 1.0); 
        }
        
        if (state.gameMode === 'party' && isHost && socket) { 
            socket.emit('host_spawn', { room: currentRoomId, data: mData }); 
        }
        return;
    }

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
    let isSwarm = (state.gameMode === 'classroom');
    let isGolden = isSwarm && (Math.random() < 0.05); 
    
    let vx = 0; 
    if (isSwarm) {
        vx = (Math.random() - 0.5) * 0.5; 
        currentSpeed = 0.25; 
    }

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

    let mData = { 
        id: Math.random().toString(36).substr(2, 9), 
        x: sx, 
        y: isBossSource ? y : (isSwarm ? Math.random() * 200 : -100), 
        
        question: displayQ, // Use the text with warning
        answer: math.a, 
        
        vx: vx, vy: 0, speed: currentSpeed, 
        isBoss: false, hp: 1, maxHp: 1, 
        isSupply: isSupply, isSummoned: isSummoned,
        isGolden: isGolden, goldenLife: 3.0,
        radius: isSwarm ? 110 : 120, 

        skin: enemySkinID,
        aura: auraType,
        
        isNemesis: isNemesis // Tag for cleanup later
    };

    if (isSummoned && window.createParticles) createParticles(sx, y, "red", 20);
    state.meteors.push(mData);
    
    if (state.gameMode === 'party' && isHost && socket) socket.emit('host_spawn', { room: currentRoomId, data: mData });
}

function findTarget(ans) {
    if (state.bossActive && state.bossData && state.bossData.shield && state.bossData.shield.active) {
        if (state.bossData.shield.a === ans) return { type: 'shield', obj: state.bossData };
    }
    let idx = state.meteors.findIndex(m => m.answer === ans);
    if (idx !== -1) return { type: 'meteor', index: idx, obj: state.meteors[idx] };
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

    // 🚨 NEMESIS REDEMPTION: Remove from "Weakness List" if answered correctly
    if (m.isNemesis) {
        // Clean the question text (remove the warning sign) to match the list
        let cleanQ = m.question.replace("⚠️ ", "");
        
        // Remove from list
        if (state.nemesisList) {
            state.nemesisList = state.nemesisList.filter(item => item.q !== cleanQ);
        }
        
        // Visual Feedback (Redemption)
        state.floatingTexts.push({ 
            x: m.x, y: m.y - 50, 
            text: "WEAKNESS OVERCOME!", 
            color: "#00ff41", // Bright Green
            life: 2.0 
        });
        if(window.Sound) window.Sound.speak("Weakness neutralized.");
    }

    // Laser Visuals
    let myTurretX = (state.gameMode === 'party') ? getTurretX(myPlayerIndex, totalPlayers) : (state.gameMode === 'vs' ? window.canvas.width/4 : window.canvas.width/2);
    
    // Get FX Color
    let fxId = (state.equipped && state.equipped.fx) ? state.equipped.fx : 'fx_blue';
    let fxItem = (typeof shopCatalog !== 'undefined') ? shopCatalog.fx.find(i => i.id === fxId) : null;
    let laserColor = fxItem ? fxItem.color : "#00e5ff";

    // 🚨 UPDATED Y1: Laser starts from top of turret (dahil pinalaki natin ang ship)
    state.lasers.push({ 
        x1: myTurretX, 
        y1: window.canvas.height - 220, 
        x2: m.x, 
        y2: m.y, 
        life: 1.0, 
        isAlly: false, 
        color: laserColor 
    });

    if (m.isSupply) { 
        handleSupplyCrate(m); state.meteors.splice(idx, 1); 
    } else if (m.isBoss) { 
        handleBossHit(m, idx); 
    } else { 
        createParticles(m.x, m.y, laserColor, 25); 
        window.Sound.laser(); window.Sound.boom(); 
        state.meteors.splice(idx, 1); 
        applyRewards(); 
    }
    
    if (state.gameMode === 'party') socket.emit('player_shoot', { room: currentRoomId, targetId: m.id, pIndex: myPlayerIndex, totalP: totalPlayers, tx: m.x, ty: m.y }); 
    updateHUD();
}

function handleMiss(val, meteorObj = null) {
    if (window.triggerGlitch) window.triggerGlitch(); 
    if (window.handleCombo) window.handleCombo(false, null, null);
    
    // Get Question Data
    let qLog = meteorObj ? meteorObj.question : "UNKNOWN";
    let aLog = meteorObj ? meteorObj.answer : "?";
    let statusLog = (val === "MISSED") ? 'missed' : 'wrong';

    registerAction(qLog, aLog, val, statusLog);

    // 🚨 NEMESIS PROTOCOL: CAPTURE THE MISTAKE 🚨
    // Kung hindi "UNKNOWN" ang tanong, at wala pa sa listahan, idagdag ito.
    if (qLog !== "UNKNOWN" && state.nemesisList) {
        // Check for duplicates para hindi paulit-ulit ang save
        const alreadyExists = state.nemesisList.some(item => item.q === qLog);
        if (!alreadyExists) {
            console.log("⚠️ WEAKNESS DETECTED:", qLog);
            state.nemesisList.push({ q: qLog, a: aLog });
            
            // Visual feedback (Optional)
            if(window.Sound) window.Sound.speak("Weakness noted.");
        }
    }

    if (state.gameMode === 'classroom') { 
        triggerInputLock(); 
        state.score = Math.max(0, state.score - 10); 
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
        createParticles(m.x, m.y, "gold", 200); // Gold explosion
        state.meteors.splice(idx, 1); 
        state.bossActive = false; 
        state.level++; 
        state.xp = 0;
        
        if (!cityLoaded && window.generateCity) generateCity();
        state.floatingTexts.push({ x: window.canvas.width / 2, y: 200, text: "TARGET NEUTRALIZED!", color: "#00ff41", life: 3.0 });
        state.shake = 50;
        
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
                 // Subtraction (Ensure no negative for simple finisher, or keep negative if you want)
                 // Let's allow negative to keep it slightly tricky but simple numbers
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

function handleSupplyCrate(m) {
    window.Sound.powerup(); let roll = Math.random();
    if (roll < 0.25) { state.health = Math.min(100, state.health + 10); state.floatingTexts.push({x:m.x, y:m.y, text:"HP +10", color:"#00e5ff", life:1.5}); } 
    else if (roll < 0.50) { state.coins += 30; state.floatingTexts.push({x:m.x, y:m.y, text:"COINS +30", color:"#fca311", life:1.5}); } 
    else if (roll < 0.75) { triggerSlowMo(true); state.floatingTexts.push({x:m.x, y:m.y, text:"FREEZE!", color:"white", life:1.5}); } 
    else { triggerEMP(true); state.floatingTexts.push({x:m.x, y:m.y, text:"MINI NUKE", color:"orange", life:1.5}); }
    createParticles(m.x, m.y, "gold", 30);
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
    if (state.gameMode === 'party') {
        if (isHost) { 
            state.xp += xpGain; 
            checkLevelUp(); 
            updateHUD();
            if (socket) {
                socket.emit('host_sync_xp', { room: currentRoomId, xp: state.xp, maxXp: state.xpToNext });
            }
        } 
        else if (socket) { 
            socket.emit('client_xp_gain', { room: currentRoomId, amount: xpGain }); 
        }
    } else {
        // Solo Logic
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

function triggerEMP(isFree, fromSocket = false) {
    if (!isFree) { if (state.coins < 100) { window.Sound.error(); window.Sound.speak("Insufficient Funds"); return; } state.coins -= 100; }
    window.Sound.nuke();
    if(!fromSocket) { window.Sound.speak("EMP Activated"); state.shockwaves.push({x: window.canvas.width/2, y: window.canvas.height, radius: 10, maxRadius: 1500, alpha: 1.0, color: "#00e5ff"}); state.shake = 30; }
    for(let i = state.meteors.length - 1; i >= 0; i--) {
        if(state.meteors[i].isBoss) { state.meteors[i].hp -= 5; } 
        else { createParticles(state.meteors[i].x, state.meteors[i].y, "#00e5ff", 20); state.meteors.splice(i, 1); if(!fromSocket) state.score += 10; }
    }
    updateHUD(); if(!fromSocket && state.gameMode === 'party' && socket) socket.emit('use_skill', { room: currentRoomId, type: 'EMP' });
}

function triggerSlowMo(isFree, fromSocket = false) {
    if (!isFree) { if (state.coins < 25) { window.Sound.error(); window.Sound.speak("Insufficient Funds"); return; } state.coins -= 25; }
    window.Sound.powerup();
    if(!fromSocket) { window.Sound.speak("Time Slowed!"); state.floatingTexts.push({x: window.canvas.width/2, y: window.canvas.height/2 - 50, text: "SLOW MOTION", color: "#00e5ff", life: 2.0}); }
    state.isSlowed = true; setTimeout(() => { state.isSlowed = false; if(!fromSocket) window.Sound.speak("Time Normal."); }, 5000);
    updateHUD(); if(!fromSocket && state.gameMode === 'party' && socket) socket.emit('use_skill', { room: currentRoomId, type: 'SLOW' });
}

window.activateEMP = function() { if (Date.now() - state.lastSkillTime < 1000) return; if (state.coins >= 100) { state.lastSkillTime = Date.now(); triggerEMP(false, false); } else { window.Sound.error(); window.Sound.speak("Insufficient Funds"); } };
window.activateSlowMo = function() { if (Date.now() - state.lastSkillTime < 1000) return; if (state.coins >= 25) { state.lastSkillTime = Date.now(); triggerSlowMo(false, false); } else { window.Sound.error(); window.Sound.speak("Insufficient Funds"); } };

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

function gameOver() {
    // 1. Stop Timers & Intervals
    if (typeof scoreInterval !== 'undefined' && scoreInterval) clearInterval(scoreInterval);
    if (state.gameTimer) clearInterval(state.gameTimer);

    // 2. VS MODE SPECIFIC: Handle "I AM DEAD" signal
    if (state.gameMode === 'vs' && socket && currentRoomId) {
        state.health = 0; // Ensure zero locally
        socket.emit('player_died', { room: currentRoomId }); // Event trigger
        
        // Force update to opponent immediately
        socket.emit('send_vs_state', { 
            room: currentRoomId, 
            state: { 
                meteors: [], 
                lasers: [], 
                health: 0, 
                score: state.score 
            } 
        });
    }

    state.isPlaying = false; 
    if(window.inputField) window.inputField.blur();

    // 3. VS MODE SCREEN (Red Defeat - Immediate Show, No Cinematic needed for VS speed)
    if (state.gameMode === 'vs') {
        const winModal = document.getElementById("win-modal");
        const winTitle = winModal.querySelector("h1");
        const winSub = winModal.querySelector(".subtitle");
        const winContent = winModal.querySelector(".modal-content");
        
        winModal.classList.remove("hidden");
        
        // Styling for DEFEAT
        winTitle.innerText = "DEFEAT";
        winTitle.style.color = "#ff0055"; // Red
        winTitle.style.textShadow = "0 0 20px #ff0055";
        
        winSub.innerText = "SYSTEM CRITICAL - MISSION FAILED";
        winSub.style.color = "#aaa";
        
        winContent.style.borderColor = "#ff0055";
        winContent.style.boxShadow = "0 0 30px #ff0055";
        
        document.getElementById("win-score").innerText = state.score;
        
        const playAgainBtn = winModal.querySelector(".secondary");
        if(playAgainBtn) playAgainBtn.style.display = "none";
        
        return; // Stop here for VS Mode
    }

    // 4. PREPARE REPORT DATA (Solo / Classroom)
    // We set up the text/buttons behind the scenes before playing the animation
    const reportModal = document.getElementById("report-modal");
    document.getElementById("rep-score").innerText = state.score;

    const rTitle = document.querySelector("#report-modal h1");
    if(rTitle) {
        rTitle.innerText = "MISSION FAILED";
        rTitle.className = "neon-red";
        rTitle.style.color = "#ff0055";
    }

    // --- BUTTON VISIBILITY LOGIC ---
    const aiBtn = reportModal.querySelector('button[onclick*="startAITraining"]');
    const retryBtn = reportModal.querySelector('button[onclick*="startSolo"]');
    const homeBtn = reportModal.querySelector('button[onclick*="goHome"]');

    if (state.gameMode === 'classroom') {
        // === CLASSROOM MODE: Student Locked ===
        if(aiBtn) aiBtn.style.display = 'none';
        if(homeBtn) homeBtn.style.display = 'none'; 

        // Lock Retry Button (Wait for Teacher)
        if(retryBtn) { 
            retryBtn.innerText = "⏳ WAITING FOR TEACHER..."; 
            retryBtn.onclick = null; 
            retryBtn.style.opacity = "0.5"; 
            retryBtn.style.cursor = "not-allowed";
            retryBtn.style.display = "block"; 
        }

        // Send Final Status to Teacher
        reportProgress(true); 
        if (currentRoomId && myDocId) { 
            const studentRef = doc(db, "rooms", currentRoomId, "students", myDocId); 
            updateDoc(studentRef, { status: 'finished' }).catch(e => console.log(e)); 
        }
    } 
    else {
        // === SOLO MODE: Full Control ===
        if(aiBtn) aiBtn.style.display = 'block';
        if(homeBtn) homeBtn.style.display = 'block';

        // Unlock Retry Button
        if(retryBtn) { 
            retryBtn.innerText = "🔄 RETRY MISSION"; 
            retryBtn.onclick = function() { 
                reportModal.classList.add("hidden"); 
                window.startSolo(); 
            }; 
            retryBtn.style.opacity = "1"; 
            retryBtn.style.cursor = "pointer";
            retryBtn.style.display = "block"; 
        }
    }

    // 5. SAVE XP TO FIREBASE (If Logged In)
    if (typeof currentUser !== 'undefined' && currentUser) {
        let xpGained = state.score; 
        let newTotal = (currentUser.totalXP || 0) + xpGained; 
        currentUser.totalXP = newTotal;
        if(typeof db !== 'undefined' && typeof updateDoc === 'function') { 
            updateDoc(doc(db, "users", currentUser.uid), { totalXP: newTotal })
            .then(() => { 
                let btn = document.getElementById("real-submit-btn"); 
                if(btn) btn.innerText = `XP SECURED (+${xpGained})`; 
            }); 
        }
    }
    
    // 6. GENERATE ANALYTICS (Behind the scenes)
    state.scoreSubmitted = false; 
    if(!currentUser) document.getElementById("real-submit-btn").innerText = "UPLOAD DATA TO HQ";

    // 7. 🎬 TRIGGER CINEMATIC OUTRO (NEW)
    // Instead of showing the modal immediately, we play the sequence first.
    // The sequence handles showing the modal after 3 seconds.
    if (window.playOutroSequence) {
        let isWin = false; // Usually GameOver = Loss in survival
        window.playOutroSequence(isWin); 
    } else {
        // Fallback if animation missing
        reportModal.classList.remove("hidden");
        if(window.generateMissionDebrief) window.generateMissionDebrief();
        if(window.generateTacticalReport) window.generateTacticalReport();
    }
}

// Inside function gameOver()
if(state.gameMode === 'classroom') {
    // Hide the "Quit" button so they stay for the next round
    const homeBtn = document.querySelector('#report-modal .text-only');
    if(homeBtn) homeBtn.style.display = 'none';
    
    const retryBtn = document.querySelector('#report-modal .secondary'); // The Retry Mission button
    if(retryBtn) retryBtn.style.display = 'none'; // They can't retry manually, only Teacher starts it
}

function gameVictory(reason) {
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

    // Hide Play Again in VS
    const playAgainBtn = winModal.querySelector(".secondary");
    if(state.gameMode === 'vs') {
        if(playAgainBtn) playAgainBtn.style.display = "none";
    } else {
        if(playAgainBtn) playAgainBtn.style.display = "block";
    }

    // Report Score
    if(socket && state.gameMode !== 'solo') socket.emit('report_score', { score: state.score });
    
    if (typeof currentUser !== 'undefined' && currentUser) {
        let xpGained = state.score + 100; // Bonus XP for Winning
        let newTotal = (currentUser.totalXP || 0) + xpGained; 
        currentUser.totalXP = newTotal;
        if(typeof db !== 'undefined' && typeof updateDoc === 'function') { 
            updateDoc(doc(db, "users", currentUser.uid), { totalXP: newTotal }); 
        }
    }
}

window.submitScore = async function() {
    window.Sound.click(); if(state.scoreSubmitted) return;
    const finalName = myName || "Agent"; document.getElementById("real-submit-btn").innerText = "UPLOADING...";
    try { await addDoc(collection(db, "scores"), { name: finalName, score: state.score, date: new Date() }); state.scoreSubmitted = true; document.getElementById("real-submit-btn").innerText = "UPLOAD SUCCESS"; } catch(e) { alert("Error uploading score."); }
};

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

        else if (m.isBoss) {
             let bossW = 600; let bossH = 450;
             // ✅ FIX: Use assets object instead of 'bossImage' variable
             let skinID = m.skin || 'boss_def';
             let imgObj = (assets.boss && assets.boss[skinID]) ? assets.boss[skinID].img : null;
             
             // Fallback to default boss image if specific skin fails
             if (!imgObj) imgObj = assets.boss['boss_def'].img;

             if(imgObj && imgObj.complete) {
                 ctx.translate(0, Math.sin(time/800)*15); 
                 ctx.drawImage(imgObj, -bossW/2, -bossH/2, bossW, bossH);
                 
                 // Boss Mechanics
                 if (!isOpponent && !m.isEntering) {
                    if(window.drawBossShield) window.drawBossShield(ctx, m, time);
                    if(window.handleBossMechanics) window.handleBossMechanics(ctx, m, time);
                 }
             } else { 
                 // Fallback Red Circle
                 ctx.fillStyle = "#550000"; ctx.beginPath(); ctx.arc(0,0,200,0,Math.PI*2); ctx.fill(); 
                 ctx.strokeStyle = "red"; ctx.lineWidth = 10; ctx.stroke();
             }
        }
        
        // =========================================
        // 3. DRAW NORMAL ENEMIES (With Dynamic Skin)
        // =========================================
        else {
            let mainColor = isOpponent ? "#ff0055" : "#00e5ff";
            let shipSize = m.radius * 2.5; 

            // Engine Thruster
            let flicker = Math.random() * 0.5 + 0.8;
            ctx.save();
            ctx.translate(0, -shipSize/2.5); 
            ctx.fillStyle = mainColor;
            ctx.shadowBlur = 20; ctx.shadowColor = mainColor;
            ctx.globalAlpha = 0.6;
            ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(10, 0); ctx.lineTo(0, -40 * flicker); ctx.fill();
            ctx.restore();

            // ✅ SKIN LOOKUP
            let skinID = m.skin || 'enemy_def';
            let imgObj = (assets.enemies[skinID]) ? assets.enemies[skinID].img : assets.enemies['enemy_def'].img;

            if (imgObj && imgObj.complete && !m.isGolden) {
                ctx.rotate(Math.PI); // Flip
                ctx.drawImage(imgObj, -shipSize/2, -shipSize/2, shipSize, shipSize);
                ctx.rotate(-Math.PI); // Reset
            } else {
                // Fallback Shape
                ctx.fillStyle = "#0a0a10";
                ctx.beginPath(); ctx.arc(0,0, m.radius, 0, Math.PI*2); ctx.fill();
                ctx.strokeStyle = mainColor; ctx.lineWidth = 3; ctx.stroke();
            }

            // HUD Plate (Equation Background)
            ctx.fillStyle = "rgba(0, 5, 10, 0.85)"; 
            ctx.strokeStyle = m.isGolden ? "gold" : mainColor;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.roundRect(-55, -20, 110, 40, 8); ctx.fill(); ctx.stroke();

            // Text
            ctx.font = "900 28px 'Rajdhani'"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillStyle = "#ffffff";
            ctx.shadowBlur = 8; ctx.shadowColor = mainColor;
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

function gameLoop(time) {
    if(!state.isPlaying || state.isPaused) return;

    let dt = time - state.lastTime; 
    state.lastTime = time; 
    let delta = dt / 16.67; 
    if(delta > 4) delta = 4; // Prevent huge jumps if laggy

    if(window.drawRain) window.drawRain();

    // --- 1. CLEANER BACKGROUND RENDERING ---
    if(cityLoaded) { 
        // Draw City Image
        window.ctx.drawImage(assets.misc.city.img, 0, 0, window.canvas.width, window.canvas.height); 
        
        // Minimal Tint (Para maliwanag pero kita ang neon)
        window.ctx.fillStyle = "rgba(0, 5, 15, 0.5)"; 
        window.ctx.fillRect(0,0,window.canvas.width, window.canvas.height); 

        // Subtle Ground Fog (Para may depth sa baba)
        let grad = window.ctx.createLinearGradient(0, window.canvas.height - 150, 0, window.canvas.height);
        grad.addColorStop(0, "rgba(0, 0, 0, 0)");
        grad.addColorStop(1, "rgba(0, 243, 255, 0.15)"); // Cyan Fog glow
        window.ctx.fillStyle = grad;
        window.ctx.fillRect(0, window.canvas.height - 150, window.canvas.width, 150);

    } else { 
        // Fallback color
        window.ctx.fillStyle = "#05070a"; 
        window.ctx.fillRect(0,0,window.canvas.width, window.canvas.height); 
    }

    // --- 2. SCREEN SHAKE EFFECT ---
    window.ctx.save();
    if(state.shake > 0) { 
        let dx = (Math.random() - 0.5) * state.shake; 
        let dy = (Math.random() - 0.5) * state.shake; 
        window.ctx.translate(dx, dy); 
        state.shake *= 0.9; 
        if(state.shake < 0.5) state.shake = 0; 
    }

    // --- 3. DRAW GROUND LINE ---
    let groundColor = state.level > 10 ? "#ff0055" : (state.level > 5 ? "#00ff41" : "#00e5ff");
    let groundY = window.canvas.height - 40;
    
    // Solid Ground Block
    window.ctx.fillStyle = "#020205"; 
    window.ctx.fillRect(0, groundY, window.canvas.width, 40);
    
    // Neon Line on top
    window.ctx.strokeStyle = groundColor; 
    window.ctx.lineWidth = 2; 
    window.ctx.shadowBlur = 10;
    window.ctx.shadowColor = groundColor;
    window.ctx.beginPath(); 
    window.ctx.moveTo(0, groundY); 
    window.ctx.lineTo(window.canvas.width, groundY); 
    window.ctx.stroke();
    
    // Reset Shadow
    window.ctx.shadowBlur = 0; 

    // --- 4. SPAWNING LOGIC ---
    if(state.gameMode === 'solo' || isHost || state.gameMode === 'vs') {
        if(time - state.spawnTimer > state.spawnRate) { 
            spawnMeteor(0,0,false); 
            state.spawnTimer = time; 
        }
    }

    // Classroom Auto-Refill (Maintain 12 drones)
    if(state.gameMode === 'classroom' && state.meteors.length < 12) {
        spawnMeteor(0,0,false); 
    }

    let speedFactor = state.isSlowed ? 0.2 : 1.0; 
    let hudNeedsUpdate = false; 

    // --- 5. MAIN PHYSICS LOOP ---
    for (let i = state.meteors.length - 1; i >= 0; i--) {
        let m = state.meteors[i];

        // Movement Logic
        if (state.gameMode === 'classroom') {
            // Floaty Movement for Classroom
            m.x += m.vx + (Math.sin(time / 800) * 0.5); 
            m.y += m.speed * delta; 

            // Bouncing Logic
            let r = m.radius;
            if (m.x < r) { m.x = r; m.vx *= -1; }
            if (m.x > window.canvas.width - r) { m.x = window.canvas.width - r; m.vx *= -1; }
            if (m.y < 100) m.y += 1; 
            
            // Floor Bounce
            if (m.y > window.canvas.height - 250) { 
                m.y = window.canvas.height - 250; 
                m.vy *= -1; 
                m.y -= 2;
            }

            // Golden Timer
            if (m.isGolden) {
                m.goldenLife -= 0.016 * delta; 
                if (m.goldenLife <= 0) { state.meteors.splice(i, 1); hudNeedsUpdate = true; continue; }
            }

        } else {
            // Survival Physics (Falling)
            if (m.isBoss) {
               if(m.isEntering) { 
                   m.y += (m.speed * 0.8) * delta; 
                   state.shake = 2; // Slight rumble during entrance
                   if(m.y >= 150) { m.isEntering = false; window.Sound.boom(); m.lastSpawn = time; } 
               } else { 
                   m.x = (window.canvas.width / 2) + Math.sin(time / 2000) * 200; 
                   if (time - m.lastSpawn > 3000) { spawnMeteor(m.x, m.y + 100, true); m.lastSpawn = time; } 
               }
            } else {
               m.y += (m.speed * speedFactor) * delta;
               // Random glitter
               if (!state.isPaused && Math.random() > 0.95) { 
                   let pColor = m.isSupply ? "gold" : (state.gameMode === 'vs' ? "red" : "cyan"); 
                   createParticles(m.x + (Math.random()-0.5)*30, m.y - 30, pColor, 1); 
               }
            }
        }
        
        // Ground Collision (Damage)
        if(state.gameMode !== 'classroom' && m.y > window.canvas.height + 50) {
            if (m.isBoss) { state.health = 0; state.shake = 50; } 
            else if (m.isSupply) {} 
            else { 
                state.health -= 20; state.shake = 20; 
                
                // 🚨 FIX: Pass the Meteor Object 'm' so we know what question was missed!
                handleMiss("MISSED", m); 
            } 
            createParticles(m.x, window.canvas.height-40, "#ff0055", 10); 
            state.meteors.splice(i, 1); 
            hudNeedsUpdate = true;
            if(state.health <= 0) gameOver();
        }
    }

    if(hudNeedsUpdate) updateHUD();

    // --- 6. DRAWING LOGIC ---
    if(state.gameMode === 'vs') {
        // VS Mode: Split Screen Logic
        drawGame(window.ctx, state.meteors, 0, false); 
        drawTurretAt(window.canvas.width/4, window.canvas.height, "#00e5ff"); 
        
        if(window.drawFirewallBarrier) { window.drawFirewallBarrier(window.ctx, window.canvas.width, window.canvas.height, time); } 
        else { 
            let mid = window.canvas.width / 2; 
            window.ctx.beginPath(); window.ctx.moveTo(mid, 0); window.ctx.lineTo(mid, window.canvas.height); 
            window.ctx.strokeStyle = "#00e5ff"; window.ctx.stroke(); 
        }
        
        // Draw Opponent Side
        window.ctx.save(); 
        window.ctx.fillStyle = "rgba(50, 0, 0, 0.2)"; 
        window.ctx.fillRect(window.canvas.width/2, 0, window.canvas.width/2, window.canvas.height); 
        window.ctx.restore();
        
        if(state.opponentState.meteors) { drawGame(window.ctx, state.opponentState.meteors, window.canvas.width / 2, true); } 
        drawTurretAt(window.canvas.width * 0.75, window.canvas.height, "#ff0055"); 
    
    } else if(state.gameMode === 'party') {
        // Party Mode
        drawGame(window.ctx, state.meteors, 0, false); 
        for(let i=0; i<totalPlayers; i++) { 
            drawTurretAt(getTurretX(i, totalPlayers), window.canvas.height, i===myPlayerIndex?"#00e5ff":"cyan"); 
        }
    } else {
        // Solo / Classroom Mode
        drawGame(window.ctx, state.meteors, 0, false); 
        drawTurretAt(window.canvas.width/2, window.canvas.height, "#00e5ff");
    }

    // --- 7. DRAW LASERS ---
    state.lasers = state.lasers.filter(l => {
        l.life -= 0.07 * delta; if (l.life <= 0) return false;
        let mainColor = l.color || "#00e5ff";
        
        // Laser Core
        window.ctx.lineWidth = 6; 
        window.ctx.strokeStyle = mainColor; 
        window.ctx.globalAlpha = 0.5 * l.life; 
        window.ctx.beginPath(); window.ctx.moveTo(l.x1, l.y1); window.ctx.lineTo(l.x2, l.y2); window.ctx.stroke(); 
        
        // Laser Beam
        window.ctx.lineWidth = 2; 
        window.ctx.strokeStyle = "#ffffff"; 
        window.ctx.globalAlpha = 1.0 * l.life; 
        window.ctx.beginPath(); window.ctx.moveTo(l.x1, l.y1); window.ctx.lineTo(l.x2, l.y2); window.ctx.stroke(); 
        
        // Impact Point
        window.ctx.fillStyle = "#ffffff"; 
        window.ctx.beginPath(); window.ctx.arc(l.x2, l.y2, 5, 0, Math.PI*2); window.ctx.fill(); 
        
        window.ctx.globalAlpha = 1.0;
        return true;
    });

    // --- 8. DRAW PARTICLES ---
    for(let i=state.particles.length-1; i>=0; i--) { 
        let p=state.particles[i]; 
        p.x += p.vx * delta; 
        p.y += p.vy * delta; 
        p.life -= 0.05 * delta; 
        
        window.ctx.fillStyle=p.color; 
        window.ctx.globalAlpha=Math.max(0, p.life); 
        window.ctx.beginPath(); window.ctx.arc(p.x,p.y,p.size,0,Math.PI*2); window.ctx.fill(); 
        if(p.life<=0) state.particles.splice(i,1); 
    }
    
    // --- 9. DRAW FLOATING TEXT ---
    for(let i=state.floatingTexts.length-1; i>=0; i--) { 
        let ft=state.floatingTexts[i]; 
        ft.y -= 1.5 * delta; 
        ft.life -= 0.02 * delta; 
        
        window.ctx.fillStyle=ft.color; 
        window.ctx.font="bold 24px 'Rajdhani'"; 
        window.ctx.globalAlpha=Math.max(0, ft.life); 
        window.ctx.shadowColor = "black";
        window.ctx.shadowBlur = 4;
        window.ctx.fillText(ft.text, ft.x, ft.y); 
        if(ft.life<=0) state.floatingTexts.splice(i,1); 
    }
    
    // --- 10. DRAW SHOCKWAVES ---
    for(let i=state.shockwaves.length-1; i>=0; i--){ 
        let sw = state.shockwaves[i]; 
        sw.radius += 20 * delta; 
        sw.alpha -= 0.05 * delta; 
        
        if(sw.alpha > 0) { 
            window.ctx.beginPath(); 
            window.ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI*2); 
            window.ctx.strokeStyle = `rgba(0, 229, 255, ${sw.alpha})`; 
            window.ctx.lineWidth = 5; 
            window.ctx.stroke(); 
        } else state.shockwaves.splice(i, 1); 
    }

    let skinKey = (state.equipped && state.equipped.turret) ? state.equipped.turret : 'turret_def';

    window.ctx.globalAlpha=1.0; 
    window.ctx.restore();
    
    requestAnimationFrame(gameLoop);
}

window.pressKey = function(key) { if(!state.isPlaying || state.isPaused) return; const input = document.getElementById("player-input"); if(input) { input.value += key; if(window.Sound) window.Sound.click(); } };
window.pressClear = function() { const input = document.getElementById("player-input"); if(input) { input.value = ""; if(window.Sound) window.Sound.error(); } };
window.pressEnter = function() { const input = document.getElementById("player-input"); if(input && state.isPlaying) { fireLaser(input.value); input.value = ""; } };
window.addEventListener('load', () => { if(window.innerWidth <= 768) console.log("Mobile Mode Detected"); });

window.handleCombo = function(isHit, x, y) {
    const elContainer = document.getElementById("combo-container"); const elValue = document.getElementById("combo-value");
    if (isHit) {
        state.combo++; if (state.combo > state.maxCombo) state.maxCombo = state.combo;
        if (state.combo > 1) {
            elContainer.classList.remove("hidden"); elValue.innerText = "x" + state.combo; elValue.classList.remove("combo-pulse"); void elValue.offsetWidth; elValue.classList.add("combo-pulse");
            let hypeMsg = ""; let hypeColor = "#fff";
            if(state.combo === 5) { hypeMsg = "GREAT!"; hypeColor = "#00ff41"; } else if(state.combo === 10) { hypeMsg = "AMAZING!"; hypeColor = "#00e5ff"; window.Sound.speak("Amazing!"); } else if(state.combo === 20) { hypeMsg = "UNSTOPPABLE!"; hypeColor = "#ffd700"; window.Sound.speak("Unstoppable!"); } else if(state.combo === 30) { hypeMsg = "MATH GOD!"; hypeColor = "#ff0055"; window.Sound.speak("Math God!"); }
            if(hypeMsg !== "") { state.floatingTexts.push({ x: x || window.canvas.width/2, y: (y || window.canvas.height/2) - 50, text: hypeMsg, color: hypeColor, life: 2.0 }); state.shake = 15; }
        }
    } else {
        if (state.combo >= 5) { state.floatingTexts.push({ x: window.canvas.width/2, y: window.canvas.height/2, text: "COMBO LOST", color: "#888", life: 1.5 }); window.Sound.error(); }
        state.combo = 0; elContainer.classList.add("hidden");
    }
};

const bgCanvas = document.getElementById("bgCanvas");
const bgCtx = bgCanvas ? bgCanvas.getContext("2d") : null;
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
window.closeTraining = function() { document.getElementById("training-modal").classList.add("hidden"); document.getElementById("start-modal").classList.remove("hidden"); state.training.active = false; };

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

window.monitorClassroom = function(code) {
    console.log("Initializing Command Center for:", code);

    // Listen to the ROOM status
    onSnapshot(doc(db, "rooms", code), (roomSnap) => {
        if(!roomSnap.exists()) return;
        const roomData = roomSnap.data();
        
        // Screens
        const rosterView = document.getElementById('view-roster');
        const podiumView = document.getElementById('view-podium');
        const awardingModal = document.getElementById('awarding-modal'); 
        const tabs = document.querySelector('.dash-tabs');
        
        // Buttons
        const startBtn = document.getElementById('btn-start-round');
        const stopBtn = document.getElementById('btn-stop-round');
        const freezeBtn = document.getElementById('btn-freeze-toggle');
        const statusEl = document.getElementById('dash-status');

        // --- 1. WAITING (Lobby) ---
        if (roomData.status === 'waiting') {
            rosterView.classList.remove('hidden');
            podiumView.classList.add('hidden');
            tabs.style.display = 'none';
            
            // Start Button: Enabled
            startBtn.innerText = "▶ START ROUND 1";
            startBtn.disabled = false;
            startBtn.style.opacity = "1";
            startBtn.classList.remove('hidden');
            startBtn.onclick = window.adminStartRound;
            
            freezeBtn.classList.add('hidden'); 
            stopBtn.classList.add('hidden');   
            
            if(statusEl) statusEl.innerText = "STATUS: STANDBY";
        } 
        
        // --- 2. PLAYING (Game Active) ---
        else if (roomData.status === 'playing') {
            rosterView.classList.add('hidden');
            podiumView.classList.remove('hidden');
            tabs.style.display = 'flex';
            awardingModal.classList.add('hidden');

            // Start Button: Disabled (Playing info)
            startBtn.classList.remove('hidden');
            startBtn.innerText = `⏳ ROUND ${roomData.currentRound} / ${roomData.maxRounds}`;
            startBtn.disabled = true; 
            startBtn.style.opacity = "0.5";
            startBtn.classList.remove('pulse-btn');

            // Freeze Button: Active & Blue
            freezeBtn.classList.remove('hidden');
            freezeBtn.innerText = "❄️ FREEZE";
            freezeBtn.className = "btn secondary"; 
            
            // Stop Button: STOP ROUND
            stopBtn.classList.remove('hidden');
            stopBtn.innerText = "⏹ STOP ROUND";
            stopBtn.className = "btn danger";
            stopBtn.onclick = window.adminForceStop;
            
            if(statusEl) statusEl.innerText = "STATUS: LIVE COMBAT";
        }
        
        // --- 3. FROZEN (Paused) ---
        else if (roomData.status === 'frozen') {
            freezeBtn.innerText = "▶ RESUME";
            freezeBtn.className = "btn primary"; 
            if(statusEl) statusEl.innerText = "STATUS: PAUSED";
        }
        
        // --- 4. ROUND ENDED (Intermission) ---
        else if (roomData.status === 'round_ended') {
            const nextRound = (parseInt(roomData.currentRound) || 0) + 1;
            
            // Start Button: Active again
            startBtn.classList.remove('hidden');
            startBtn.disabled = false;
            startBtn.style.opacity = "1";
            startBtn.classList.remove('pulse-btn');
            
            // Freeze: Hidden
            freezeBtn.classList.add('hidden');

            // Stop Button: Becomes End Class
            stopBtn.classList.remove('hidden');
            stopBtn.innerText = "❌ END CLASS";
            stopBtn.className = "btn danger";
            stopBtn.onclick = window.adminForceStop;

            // Trigger Timer ONCE (kung hindi pa nag-aauto start)
            if (!isAutoStarting && typeof intermissionSeconds !== 'undefined') {
                 // Reset timer variable just in case
                 if(intermissionSeconds <= 0) intermissionSeconds = 10;
                 window.startIntermissionCountdown(nextRound);
            }
            
            if(statusEl) statusEl.innerText = "STATUS: INTERMISSION";
        }
        
        // --- 5. FINISHED (Game Over) ---
        else if (roomData.status === 'finished') {
             awardingModal.classList.remove('hidden');
             if(window.generateClassDiagnostics) window.generateClassDiagnostics();
        }
    });

    // Student List Logic (Keep this)
    const q = query(collection(db, "rooms", code, "students"));
    if(dashboardUnsub) dashboardUnsub(); 
    let renderTimeout;
    dashboardUnsub = onSnapshot(q, (snapshot) => {
        currentStudentData = [];
        snapshot.forEach(doc => { currentStudentData.push(doc.data()); });
        currentStudentData.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
        
        clearTimeout(renderTimeout);
        renderTimeout = setTimeout(() => {
            if(window.updatePodiumView) window.updatePodiumView();
            if(window.updateSpyView) window.updateSpyView();
            if(window.updateReportView) window.updateReportView();
            if(window.updateRosterView) window.updateRosterView(); 
        }, 200); 
    });
};

// 2. VIEW: PODIUM (UPDATED PHASE 4.1)
window.updatePodiumView = function() {
    if(!document.getElementById('p1-name')) return;
    
    // Data is already sorted by totalScore from the query
    const p1 = currentStudentData[0] || {name: '-', totalScore: 0};
    const p2 = currentStudentData[1] || {name: '-', totalScore: 0};
    const p3 = currentStudentData[2] || {name: '-', totalScore: 0};

    // Update Text to use totalScore
    document.getElementById('p1-name').innerText = p1.name; 
    document.getElementById('p1-score').innerText = p1.totalScore || 0;
    
    document.getElementById('p2-name').innerText = p2.name; 
    document.getElementById('p2-score').innerText = p2.totalScore || 0;
    
    document.getElementById('p3-name').innerText = p3.name; 
    document.getElementById('p3-score').innerText = p3.totalScore || 0;

    const list = document.getElementById('podium-list-body');
    if(list) {
        list.innerHTML = "";
        for(let i=3; i<currentStudentData.length; i++) {
            let s = currentStudentData[i];
            list.innerHTML += `<div class="player-row" style="padding: 10px; border-bottom: 1px solid #333; display: flex; justify-content: space-between;"><span style="color:#888; font-weight:bold;">#${i+1} ${s.name}</span><span style="color:#00e5ff;">${s.totalScore || 0}</span></div>`;
        }
    }
};
// NEW VIEW: CLASS ROSTER (For Lobby)
window.updateRosterView = function() {
    const container = document.getElementById('roster-grid');
    if(!container) {
        console.warn("Roster Grid container not found!");
        return;
    }

    console.log("Updating Roster with:", currentStudentData.length, "students"); // Debug Log

    container.innerHTML = "";
    if (currentStudentData.length === 0) {
        container.innerHTML = `<div style="grid-column: 1/-1; text-align:center; color:#666; padding:20px; font-family:'Rajdhani';">WAITING FOR SIGNALS...</div>`;
        return;
    }

    currentStudentData.forEach(s => {
        // Create card element
        const card = document.createElement('div');
        card.className = 'roster-card';
        card.innerHTML = `
            <h4 style="margin:0; color:white; font-family:'Orbitron'; font-size:18px;">${s.name}</h4>
            <span style="font-size:12px; color:#00ff41; display:block; margin-top:5px; font-family:'Rajdhani';">● ONLINE</span>
        `;
        container.appendChild(card);
    });
};

// 3. VIEW: SPY GRID
window.updateSpyView = function() {
    const grid = document.getElementById('spy-grid-container');
    if(!grid || document.getElementById('view-grid').classList.contains('hidden')) return;

    grid.innerHTML = "";
    const now = Date.now();

    currentStudentData.forEach(s => {
        let statusIcon = '⚫'; 
        let cardBorder = '#333';
        let opacity = '1';

        // 👻 GHOST DETECTION LOGIC
        // If lastActive is more than 15 seconds ago, mark as OFFLINE
        let isOffline = false;
        if (s.lastActive && (now - s.lastActive > 15000) && s.status !== 'finished') {
            isOffline = true;
            statusIcon = '🔌'; // Disconnected icon
            cardBorder = '#555';
            opacity = '0.5'; // Gray out
        } 
        else {
            // Normal Status Logic
            if(s.status === 'online') { statusIcon = '🟢'; cardBorder = '#00ff41'; }
            if(s.status === 'playing') { statusIcon = '🎮'; cardBorder = '#00e5ff'; }
            let isFrozen = s.inputLocked; 
            if(isFrozen) { statusIcon = '❄️'; cardBorder = '#ff0055'; }
        }

        let progress = Math.min(100, (s.currentScore / 1000) * 100);

        grid.innerHTML += `
            <div class="spy-card" style="border-color: ${cardBorder}; opacity: ${opacity}; background: #111; padding: 10px; border-radius: 8px; margin-bottom: 10px;">
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:white; font-weight:bold;">${s.name}</span>
                    <span style="font-size: 14px;">${statusIcon}</span>
                </div>
                <div style="font-size:12px; color:#888; margin: 5px 0;">ACC: ${s.accuracy || 100}%</div>
                <div class="spy-bar" style="width:100%; height:4px; background:#333; margin-top:5px;">
                    <div class="spy-fill" style="width:${progress}%; height:100%; background:${isOffline ? '#555' : (s.inputLocked ? '#ff0055' : '#00e5ff')}; transition:width 0.5s;"></div>
                </div>
                <div style="font-size:11px; margin-top:8px; color:${isOffline ? '#888' : (s.inputLocked ? '#ff0055' : '#ffd700')}; font-family:'Courier New', monospace;">
                    ${isOffline ? 'SIGNAL LOST' : (s.inputLocked ? '⛔ JAMMED' : 'INPUT: ' + (s.lastAnswer || '...'))}
                </div>
            </div>`;
    });
};

// 4. VIEW: SMART REPORT LIST (FIXED & CLEANED)
// 4. VIEW: SMART REPORT LIST (FIXED)
window.updateReportView = function() {
    // 🚨 FIX: Match the ID to your HTML (<tbody id="report-list-body">)
    const tbody = document.getElementById('report-list-body'); 
    if(!tbody) return;
    
    // 1. UPDATE HEADER
    const thead = document.querySelector('#view-reports thead tr');
    if(thead) {
        thead.innerHTML = `
            <th style="padding: 10px;">AGENT</th>
            <th style="padding: 10px; text-align:center;">ROUNDS</th>
            <th style="padding: 10px; text-align:center;">TOTAL SCORE</th>
            <th style="padding: 10px; text-align:center;">ACC %</th>
            <th style="padding: 10px; text-align:center;">STATUS</th>
        `;
    }

    // 2. SORT (Help Needed -> Total Score -> Name)
    currentStudentData.sort((a, b) => {
        if (a.needsHelp && !b.needsHelp) return -1;
        if (!a.needsHelp && b.needsHelp) return 1;
        return (b.totalScore || 0) - (a.totalScore || 0);
    });

    tbody.innerHTML = "";
    const now = Date.now();
    let activeHelpRequests = 0;
    let classTotalScore = 0;
    let classTotalAcc = 0;

    // 3. POPULATE ROWS
    currentStudentData.forEach(s => {
        classTotalScore += (s.totalScore || 0);
        classTotalAcc += (s.accuracy || 100);

        // Status Logic
        let statusBadge = `<span style="color:#00ff41">● ONLINE</span>`;
        let rowClass = "";

        if (s.lastActive && (now - s.lastActive > 15000) && s.status !== 'finished') {
            statusBadge = `<span style="color:#666">🔌 OFFLINE</span>`;
        } else if (s.status === 'finished') {
            statusBadge = `<span style="color:#00e5ff">🏁 DONE</span>`;
        } else if (s.needsHelp) {
            statusBadge = `<span style="color:#ffd700; font-weight:bold; animation: blink 1s infinite;">✋ HELP!</span>`;
            rowClass = "on-fire-row"; 
            activeHelpRequests++;
        }

        // Render Row
        tbody.innerHTML += `
            <tr class="${rowClass}" style="border-bottom:1px solid #222; color:white; text-align:center;">
                <td style="padding:12px; font-weight:bold; text-align:left;">${s.name}</td>
                <td style="padding:12px; color:#aaa;">${s.roundsPlayed || 0}</td>
                <td style="padding:12px; font-family:'Courier New'; font-weight:bold; color:#ffd700;">${s.totalScore || 0}</td>
                <td style="padding:12px; color:${(s.accuracy || 100) < 50 ? '#ff0055' : '#00ff41'}">${s.accuracy || 100}%</td>
                <td style="padding:12px; font-size:12px;">${statusBadge}</td>
            </tr>`;
    });

    // 4. UPDATE CLASS SUMMARY BOXES
    let avgScore = currentStudentData.length ? Math.floor(classTotalScore / currentStudentData.length) : 0;
    let avgAcc = currentStudentData.length ? Math.floor(classTotalAcc / currentStudentData.length) : 0;
    
    const avgScoreEl = document.getElementById('rep-avg-score');
    const avgAccEl = document.getElementById('rep-avg-acc');
    
    if(avgScoreEl) avgScoreEl.innerText = avgScore;
    if(avgAccEl) {
        avgAccEl.innerText = avgAcc + "%";
        avgAccEl.style.color = avgAcc < 50 ? "#ff0055" : "#00ff41";
    }
    
    // Voice Alert Logic
    if (activeHelpRequests > 0 && !window.hasAlerted) {
        if(window.Sound) {
            window.Sound.playTone(600, 'square', 0.1); 
            window.Sound.speak("Commander, check status reports.");
        }
        window.hasAlerted = true; 
    } 
    if (activeHelpRequests === 0) {
        window.hasAlerted = false; 
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


async function reportProgress(isFinal = false) {
    if (!currentRoomId || state.gameMode !== 'classroom') return;
    if (!myDocId) { myDocId = currentUser ? currentUser.uid : myName; }

    try {
        const studentRef = doc(db, "rooms", currentRoomId, "students", myDocId);
        
        // --- CALCULATE ACCURACY ---
        let estimatedHits = Math.floor(state.score / 10); 
        let totalMisses = state.mistakes.length;
        let totalAttempts = estimatedHits + totalMisses;
        let accuracy = totalAttempts > 0 ? Math.round((estimatedHits / totalAttempts) * 100) : 100;
        if (accuracy > 100) accuracy = 100; if (accuracy < 0) accuracy = 0;

        // --- 📊 ANALYTICS: IDENTIFY WEAKNESS (Feature #5) ---
        let errorCounts = { '+': 0, '-': 0, 'x': 0, '÷': 0, 'Alg': 0 };
        state.mistakes.forEach(m => { 
            let qStr = m.q.toString();
            if(qStr.includes('x') && qStr.includes('=')) errorCounts['Alg']++;
            else if(qStr.includes('+')) errorCounts['+']++;
            else if(qStr.includes('-')) errorCounts['-']++;
            else if(qStr.includes('x')) errorCounts['x']++; // 'x' for multiply symbol
            else if(qStr.includes('÷')) errorCounts['÷']++;
        });
        // Find highest error count
        let weakness = Object.keys(errorCounts).reduce((a, b) => errorCounts[a] > errorCounts[b] ? a : b);
        if (errorCounts[weakness] === 0) weakness = "None"; // No weakness yet

        await updateDoc(studentRef, { 
            currentScore: state.score,
            totalScore: state.score,
            accuracy: accuracy,
            roundsPlayed: state.roundsPlayed,
            status: isFinal ? 'finished' : 'playing', 
            inputLocked: state.inputLocked,
            lastAnswer: window.inputField ? window.inputField.value : "",
            lastActive: Date.now(),
            needsHelp: state.helpRequested,
            weakestLink: weakness // <--- SENDING ANALYTICS DATA
        });
    } catch(e) { console.error("Report Error:", e); } 
}

// 7. UTILS
window.switchDashTab = function(tabName) {
    if(window.Sound) window.Sound.click();
    document.querySelectorAll('.dash-view').forEach(d => d.classList.add('hidden'));
    document.querySelectorAll('.dash-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`view-${tabName}`).classList.remove('hidden');
    if(event && event.target) event.target.classList.add('active');
    if(tabName === 'grid') updateSpyView();
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

    if (imgObj && imgObj.complete && imgObj.src) {
        // 🚨 SIZE UPDATE: Ginawa nating 360px para malaki at kita sa likod ng input box
        let width = 360; 
        let height = 360; 
        
        // Positioning: 
        // -width/2 = Center X
        // -height + 60 = I-angat nang konti mula sa baba para hindi putol
        ctx.drawImage(imgObj, -width/2, -height + 80, width, height);
    } else {
        // Fallback Geometry (Kung walang image)
        ctx.fillStyle = fxColor; ctx.fillRect(-10, -100, 20, 100); // Barrel
        ctx.fillStyle = "#111"; // Body
        ctx.beginPath(); ctx.moveTo(-60, 0); ctx.lineTo(0, -120); ctx.lineTo(60, 0); ctx.fill();
        ctx.strokeStyle = fxColor; ctx.lineWidth = 4; ctx.stroke();
    }
    
    // --- 4. MUZZLE GLOW (Opsyonal na effect sa dulo ng baril) ---
    // Ito ay nasa taas ng input box visually
    ctx.shadowBlur = 20; ctx.shadowColor = fxColor;
    ctx.fillStyle = fxColor;
    // Pwesto sa taas ng ship
    ctx.beginPath(); ctx.arc(0, -220, 5, 0, Math.PI*2); ctx.fill();

    ctx.restore();
};


window.fixGameResolution = function() { 
    if (!window.canvas) window.canvas = document.getElementById("gameCanvas");
    if(window.canvas) {
        // 1. Get the actual display size
        let rect = window.canvas.getBoundingClientRect();
        
        // 2. Set internal resolution to match display size
        window.canvas.width = rect.width; 
        window.canvas.height = rect.height; 
        
        // 3. Re-generate background elements to fit new size
        if(typeof state !== 'undefined' && state.isPlaying) { 
            if(window.generateCity) generateCity(); 
            if(window.initStars) initStars(); 
        }
    }
    
    // Fix Background Canvas as well
    const bgCanvas = document.getElementById("bgCanvas"); 
    if(bgCanvas) { 
        let rect = bgCanvas.getBoundingClientRect();
        bgCanvas.width = rect.width; 
        bgCanvas.height = rect.height; 
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

// ADD: Logic for Input Jamming (Penalty)
function triggerInputLock() {
    if (state.inputLocked) return; // Already locked

    // Safety: Clear any existing timer to prevent stacking
    if (state.lockTimer) {
        clearInterval(state.lockTimer);
        state.lockTimer = null;
    }

    state.inputLocked = true;
    const input = document.getElementById("player-input");
    if (!input) return;

    // Visuals: Lock
    input.classList.add("input-jammed");
    input.blur(); // Remove focus
    
    if(window.Sound) window.Sound.error();

    let timeLeft = 3; // 3 Seconds
    input.value = `LOCKED (${timeLeft})`;

    // CHANGE: Save the interval ID to the global state object, NOT a local variable
    state.lockTimer = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            input.value = `LOCKED (${timeLeft})`;
        } else {
            // Unlock
            clearInterval(state.lockTimer); // Clear the global timer
            state.lockTimer = null;         // Clean up the ID
            
            state.inputLocked = false;
            input.classList.remove("input-jammed");
            input.value = "";
            input.focus();
            input.placeholder = "SYSTEM REBOOTED";
            setTimeout(() => input.placeholder = "AWAITING INPUT...", 1000);
        }
    }, 1000);
}

// 1. Class Selection Menu Handlers (SMART RESUME)
// 1. Class Selection Menu Handlers (SMART RESUME)
window.openClassSelection = function() {
    if(window.Sound) window.Sound.click();

    // ✅ CHECK FOR EXISTING SESSION FIRST
    if (pendingSessionData) {
        let roomCode = pendingSessionData.room.replace("CLASS-", "");
        let role = pendingSessionData.role.toUpperCase();
        
        // Ask user: Resume or New?
        if (confirm(`DETECTED ACTIVE SESSION:\n\nRole: ${role}\nClass: ${roomCode}\n\nDo you want to RECONNECT?`)) {
            window.resumeClassSession();
            return; // Stop here, don't open selection menu
        } else {
            // User chose Cancel -> Clear old session and start fresh
            clearSession();
        }
    }

    // Normal Flow (If no session or user cancelled resume)
    document.getElementById("start-modal").classList.add("hidden");
    document.getElementById("class-selection-modal").classList.remove("hidden");
    
    // Reset state
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
    window.showClassroomSetup(); // Opens the setup modal
};

window.selectStudentRole = function() {
    if(window.Sound) window.Sound.click();
    // Hide buttons, show input
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
    // HACK: Pass to main join function
    const mainJoinInput = document.getElementById("join-code-input");
    if(mainJoinInput) {
        mainJoinInput.value = directInput;
        // 🚨 FIX: Wag itago ang modal dito! Hayaan ang joinRoom ang magsara kapag connected na.
        // document.getElementById("class-selection-modal").classList.add("hidden"); <--- TANGGALIN ITO
        window.joinRoom(); 
    }
};

window.joinRoom = async function() {
    const codeInput = document.getElementById("join-code-input");
    const code = codeInput.value.toUpperCase().trim();
    if(code.length < 4) return alert("Invalid Room Code");
    if(!window.validateName()) return; 

    try {
        const roomRef = doc(db, "rooms", code);
        const roomSnap = await getDoc(roomRef);
        
        if(!roomSnap.exists()) {
            // 🚨 FIX: Stay on screen, just alert the error.
            // Student is NOT trapped in void anymore.
            return alert("Room not found! Check the code."); 
        }
        
        // --- SUCCESS! NGAYON NATIN ISARA ANG MENUS ---
        document.getElementById("start-modal").classList.add("hidden");
        document.getElementById("mp-menu-modal").classList.add("hidden");
        document.getElementById("class-selection-modal").classList.add("hidden"); // Close Class Menu
        
        const roomData = roomSnap.data();
        
        if (roomData.mode === 'classroom') {
            state.gameMode = 'classroom';
            currentRoomId = code;
            isHost = false;
            
            myDocId = currentUser ? currentUser.uid : myName;
            const studentRef = doc(db, "rooms", code, "students", myDocId);
            
            await setDoc(studentRef, {
                name: myName, 
                status: 'online', 
                currentScore: 0, 
                totalScore: 0, 
                accuracy: 100, 
                joinedAt: new Date()
            }, { merge: true }); 

            saveSession('student', code, myName, myDocId);

            if(roomData.config) {
                state.difficulty = roomData.config.difficulty;
                state.classroomTopic = roomData.config.topic; 
                if (roomData.config.ops) state.selectedOps = roomData.config.ops;
            }
            enterClassroomLobby(code, roomData.roomName);
        } else {
            // Multiplayer logic (Existing)
            state.gameMode = roomData.mode || 'party';
            isHost = false;
            if (roomData.settings) {
                state.selectedOps = roomData.settings.ops;
                state.difficulty = roomData.settings.diff;
            }
            let newPlayers = roomData.players || [];
            if (!newPlayers.some(p => p.name === myName)) {
                newPlayers.push({name: myName});
                await updateDoc(roomRef, { players: newPlayers });
            }
            myPlayerIndex = newPlayers.length - 1; 
            currentRoomId = code; 
            enterLobbyUI(code);
            if(socket) socket.emit('join_room', { room: code, name: myName });
        }
    } catch(e) { console.error(e); alert("Error joining room: " + e.message); }
};

window.joinRoom = async function() {
    const codeInput = document.getElementById("join-code-input");
    const code = codeInput.value.toUpperCase().trim();
    if(code.length < 4) return alert("Invalid Room Code");
    if(!window.validateName()) return; 

    try {
        const roomRef = doc(db, "rooms", code);
        const roomSnap = await getDoc(roomRef);
        
        if(!roomSnap.exists()) {
            // 🚨 FIX: Stay on screen, just alert the error.
            // Student is NOT trapped in void anymore.
            return alert("Room not found! Check the code."); 
        }
        
        // --- SUCCESS! NGAYON NATIN ISARA ANG MENUS ---
        document.getElementById("start-modal").classList.add("hidden");
        document.getElementById("mp-menu-modal").classList.add("hidden");
        document.getElementById("class-selection-modal").classList.add("hidden"); // Close Class Menu
        
        const roomData = roomSnap.data();
        
        if (roomData.mode === 'classroom') {
            state.gameMode = 'classroom';
            currentRoomId = code;
            isHost = false;
            
            myDocId = currentUser ? currentUser.uid : myName;
            const studentRef = doc(db, "rooms", code, "students", myDocId);
            
            await setDoc(studentRef, {
                name: myName, 
                status: 'online', 
                currentScore: 0, 
                totalScore: 0, 
                accuracy: 100, 
                joinedAt: new Date()
            }, { merge: true }); 

            saveSession('student', code, myName, myDocId);

            if(roomData.config) {
                state.difficulty = roomData.config.difficulty;
                state.classroomTopic = roomData.config.topic; 
                if (roomData.config.ops) state.selectedOps = roomData.config.ops;
            }
            enterClassroomLobby(code, roomData.roomName);
        } else {
            // Multiplayer logic (Existing)
            state.gameMode = roomData.mode || 'party';
            isHost = false;
            if (roomData.settings) {
                state.selectedOps = roomData.settings.ops;
                state.difficulty = roomData.settings.diff;
            }
            let newPlayers = roomData.players || [];
            if (!newPlayers.some(p => p.name === myName)) {
                newPlayers.push({name: myName});
                await updateDoc(roomRef, { players: newPlayers });
            }
            myPlayerIndex = newPlayers.length - 1; 
            currentRoomId = code; 
            enterLobbyUI(code);
            if(socket) socket.emit('join_room', { room: code, name: myName });
        }
    } catch(e) { console.error(e); alert("Error joining room: " + e.message); }
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

window.createClassroom = async function() {
    console.log("Initializing Class Creation...");

    if(!window.validateName()) {
        console.warn("Name validation failed.");
        return;
    }

    const classNameInput = document.getElementById('class-name-input');
    const className = classNameInput ? classNameInput.value : "Classroom";
    
    // CAPTURE TIME
    const timeDisplay = document.getElementById('time-display');
    const minutes = timeDisplay ? parseInt(timeDisplay.getAttribute('data-value')) : 2;

    // CAPTURE ROUNDS
    const roundsDisplay = document.getElementById('rounds-display');
    const maxRounds = roundsDisplay ? parseInt(roundsDisplay.getAttribute('data-value')) : 1;
    
    // CAPTURE TOPIC & OPS
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
    console.log("Generated Class Code:", code);

    currentRoomId = code; isHost = true; state.gameMode = 'classroom';

    saveSession('teacher', code, myName);

    // --- 🚨 UI SWITCH (EMERGENCY FORCE VISIBILITY) 🚨 ---
    try {
        // 1. Add special class to BODY to hide game canvas via CSS
        document.body.classList.add('dashboard-active');

        // 2. Hide Setup Modal
        const setupModal = document.getElementById('classroom-setup-modal');
        if (setupModal) setupModal.classList.add('hidden');
        
        // 3. Force Show Dashboard
        const dash = document.getElementById('teacher-dashboard');
        if (dash) {
            dash.classList.remove('hidden');
            dash.style.display = 'flex'; // Override any display:none
        }
        

        const roomCodeEl = document.getElementById('dash-room-code');
        const statusEl = document.getElementById('dash-status');
    
        if (roomCodeEl) roomCodeEl.innerText = code.replace("CLASS-", ""); 
        
        if (statusEl) statusEl.innerText = "STATUS: WAITING FOR AGENTS...";
        
        console.log("✅ UI FORCED SWITCH SUCCESS");
    } catch (uiError) {
        console.error("❌ UI CRITICAL ERROR:", uiError);
        alert("UI Failed to Switch. Check Console.");
    }

    // --- SAVE TO FIRESTORE ---
    try {
        await setDoc(doc(db, "rooms", code), {
            host: myName, roomName: className, mode: 'classroom', status: 'waiting',
            
            // SAVE ROUND INFO
            currentRound: 0,
            maxRounds: maxRounds,
            
            config: { 
                timeLimit: minutes * 60, 
                difficulty: difficulty,
                topic: topic,      
                ops: selectedOps    
            },
            createdAt: new Date()
        });
        console.log("Room created in Firestore");
        window.monitorClassroom(code);
    } catch (e) { 
        console.error("Firestore Error:", e);
        alert("Error creating class: " + e.message); 
    }
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


document.addEventListener("keydown", function(event) {
    if (!state.isPlaying || state.isPaused) return;

    // ✅ NEW: STRICT LOCK CHECK
    // If locked, BLOCK ALL INPUTS immediately
    if (state.inputLocked) {
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    const input = document.getElementById("player-input");

    // --- A. COMMAND KEYS ---
    if (event.key === "Enter") {
        event.preventDefault();
        if (input && input.value !== "") {
            fireLaser(input.value);
            input.value = "";
        }
        return;
    }

    if (event.code === "Space") {
        event.preventDefault();
        if (window.activateEMP) window.activateEMP();
        return;
    }

    if (event.key === "Shift") {
        event.preventDefault();
        if (window.activateSlowMo) window.activateSlowMo();
        return;
    }

    // --- B. TYPING LOGIC ---
    const allowedKeys = [
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-', 
        'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab'
    ];

    if (allowedKeys.includes(event.key)) {
        if (input && document.activeElement !== input) {
            input.focus();
        }
    } else {
        event.preventDefault();
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

// --- ✋ STUDENT HELP SYSTEM ---
window.toggleHelp = function() {
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
    
    // Force immediate report update
    reportProgress(false);
};

window.generateClassDiagnostics = function() {
    console.log("Generating Class Heatmap...");
    
    // 1. TOP PERFORMERS (Existing Logic)
    const winnersContainer = document.getElementById('winners-podium');
    if(winnersContainer) {
        winnersContainer.innerHTML = "";
        const medals = ["🥇", "🥈", "🥉"];
        const winners = currentStudentData.slice(0, 3);
        winners.forEach((w, index) => {
            let rankClass = `rank-${index + 1}`;
            winnersContainer.innerHTML += `
                <div class="winner-card ${rankClass}">
                    <span class="winner-medal">${medals[index]}</span>
                    <div class="winner-name">${w.name}</div>
                    <div class="winner-score">${w.totalScore}</div>
                </div>`;
        });
    }

    // 2. 📊 HEATMAP ANALYTICS (Feature #5)
    // Tally weaknesses
    let tally = { '+': 0, '-': 0, 'x': 0, '÷': 0, 'Alg': 0, 'None': 0 };
    currentStudentData.forEach(s => {
        let w = s.weakestLink || 'None';
        if (tally[w] !== undefined) tally[w]++;
    });

    // Find Topic with most failures
    let worstTopic = Object.keys(tally).reduce((a, b) => (tally[a] > tally[b] && a !== 'None') ? a : b);
    if (tally[worstTopic] === 0) worstTopic = "None";

    const weaknessEl = document.getElementById('class-weakness-report');
    if(weaknessEl) {
        // Generate Bar Chart HTML
        let chartHTML = `<div style="display:flex; align-items:flex-end; height:100px; gap:5px; margin-top:10px;">`;
        
        // Define labels mapping
        const labels = { '+': 'ADD', '-': 'SUB', 'x': 'MUL', '÷': 'DIV', 'Alg': 'ALG' };
        
        for (let key in labels) {
            let count = tally[key];
            let height = count > 0 ? Math.max(10, (count / currentStudentData.length) * 100) : 5;
            let color = key === worstTopic ? '#ff0055' : '#00e5ff';
            
            chartHTML += `
                <div style="flex:1; display:flex; flex-direction:column; align-items:center;">
                    <div style="width:100%; height:${height}%; background:${color}; border-radius:3px 3px 0 0; position:relative;">
                        <span style="position:absolute; top:-15px; left:50%; transform:translateX(-50%); font-size:10px; color:white;">${count}</span>
                    </div>
                    <span style="font-size:10px; color:#888; margin-top:5px;">${labels[key]}</span>
                </div>
            `;
        }
        chartHTML += `</div>`;

        let advice = "Class performance is stable.";
        if (worstTopic !== 'None') advice = `CRITICAL ALERT: Class is struggling with [ ${labels[worstTopic]} ]. Review recommended.`;

        weaknessEl.innerHTML = `
            <div style="margin-bottom:5px; color:#ccc;">TOPIC MASTERY HEATMAP</div>
            ${chartHTML}
            <div style="font-style:italic; color:${worstTopic !== 'None' ? '#ff0055' : '#00ff41'}; font-size:12px; margin-top:10px;">
                "${advice}"
            </div>
        `;
    }

    // 3. STRUGGLING STUDENTS LIST
    const strugglingList = document.getElementById('struggling-students-list');
    const struggling = currentStudentData.filter(s => s.accuracy < 60); // < 60% accuracy
    
    if(strugglingList) {
        if(struggling.length > 0) {
            strugglingList.innerHTML = struggling.map(s => 
                `<div style="color:#ff5555; margin-bottom:5px; border-bottom:1px solid #333; padding-bottom:2px;">
                    ⚠️ <b>${s.name}</b> (${s.accuracy}%) <span style="font-size:10px; color:#aaa;">Weakness: ${s.weakestLink || '?'}</span>
                </div>`
            ).join("");
        } else {
            strugglingList.innerHTML = `<span style="color:#00ff41;">ALL SYSTEMS NOMINAL. No critical failures.</span>`;
        }
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

// --- 🛸 GALACTIC WAR INTRO LOGIC ---
window.addEventListener('load', () => {
    const intro = document.getElementById('cinematic-intro');
    const warContainer = document.getElementById('war-container');
    const statusText = document.querySelector('.loading-status');

    if (!intro || !warContainer) return;

    // 1. SPAWN LASERS & SHIPS (Chaos Effect)
    const warInterval = setInterval(() => {
        spawnWarEffect();
    }, 100); // Create chaos every 100ms

    function spawnWarEffect() {
        // Create Laser
        const laser = document.createElement('div');
        laser.className = Math.random() > 0.5 ? 'laser-beam' : 'laser-beam ally-laser';
        
        // Random Position & Speed
        let startY = Math.random() * window.innerHeight;
        let width = Math.random() * 300 + 100;
        let duration = Math.random() * 0.5 + 0.2;
        
        laser.style.width = width + "px";
        laser.style.top = startY + "px";
        
        // Direction: Left to Right or Right to Left
        if (Math.random() > 0.5) {
            laser.style.left = "-200px";
            laser.animate([
                { transform: 'translateX(0)' },
                { transform: `translateX(${window.innerWidth + 400}px)` }
            ], { duration: duration * 1000, easing: 'linear' });
        } else {
            laser.style.right = "-200px";
            laser.animate([
                { transform: 'translateX(0)' },
                { transform: `translateX(-${window.innerWidth + 400}px)` }
            ], { duration: duration * 1000, easing: 'linear' });
        }

        warContainer.appendChild(laser);

        // Cleanup Laser
        setTimeout(() => { laser.remove(); }, duration * 1000);

        // Rare Ship Spawn (Background Silhouettes)
        if (Math.random() > 0.9) {
            const ship = document.createElement('div');
            ship.className = 'space-ship';
            ship.style.top = Math.random() * window.innerHeight + "px";
            ship.style.left = "-50px";
            ship.style.opacity = Math.random() * 0.5 + 0.2;
            ship.style.transform = `scale(${Math.random() * 0.5 + 0.5})`;
            
            ship.animate([
                { transform: 'translateX(0)' },
                { transform: `translateX(${window.innerWidth + 100}px)` }
            ], { duration: 2000, easing: 'ease-out' });
            
            warContainer.appendChild(ship);
            setTimeout(() => { ship.remove(); }, 2000);
        }
    }

    // 4. EXIT SEQUENCE (Updated)
    setTimeout(() => {
        clearInterval(warInterval); // Stop chaos
        intro.classList.add('warp-out'); // Warp speed exit
        
        setTimeout(() => {
            // 🚨 CHANGE: Instead of just hiding, we start the story
            // intro.style.display = 'none'; <--- DELETE THIS
            window.startStoryMode(); // <--- ADD THIS
        }, 1000); 
    }, 5500);
    // 3. SOUND FX (If available)
    if(window.Sound) {
        setTimeout(() => window.Sound.playTone(50, 'sawtooth', 0.5), 500); // Intro rumble
        setTimeout(() => window.Sound.playTone(100, 'square', 0.5), 1000); // Slam Impact
        setTimeout(() => window.Sound.speak("Math Defender. Systems Online."), 4000);
    }


});

// --- 📖 STORY & TUTORIAL LOGIC ---

const storyData = [
    {
        text: "AGENT, DO YOU COPY? This is Commander Vector. The Nullifiers have breached the Logic Gate.",
        visual: null
    },
    {
        text: "They feed on chaos. Their weakness? PURE MATHEMATICS. Your keyboard is your weapon system.",
        visual: null
    },
    {
        text: "TARGET ACQUIRED: Solve the equation on the approaching threats to charge your lasers.",
        visual: `<div class="demo-meteor">5 + 3</div><br>⬇️<br><span style="color:#00e5ff">TYPE "8" & ENTER</span>`
    },
    {
        text: "WARNING: If they reach the ground, our shields will take damage. Do not let them pass.",
        visual: `<span style="color:#ff0055">SHIELD INTEGRITY CRITICAL</span>`
    },
    {
        text: "Every 5th Wave, a MOTHERSHIP will appear. It requires multiple calculations to destroy.",
        visual: `<span style="color:#ffd700; font-size: 20px;">⚠️ BOSS DETECTED ⚠️</span>`
    },
    {
        text: "Good luck, Agent. Humanity is counting on you. VECTOR OUT.",
        visual: null
    }
];

let storyIndex = 0;
let isTyping = false;

window.startStoryMode = function() {
    const storyOverlay = document.getElementById('story-overlay');
    const intro = document.getElementById('cinematic-intro'); // Ensure intro is hidden
    
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
    const speed = 30; // Typing speed ms
    
    // Play voice if available
    if(window.Sound && index === 0) window.Sound.speak("Incoming transmission.");

    function type() {
        if (i < data.text.length) {
            textEl.innerHTML += data.text.charAt(i);
            i++;
            // Typing sound effect
            if (i % 3 === 0 && window.Sound) window.Sound.playTone(800, 'square', 0.05);
            setTimeout(type, speed);
        } else {
            isTyping = false;
            btn.disabled = false;
            
            // Show Visual if exists
            if (data.visual) {
                visualEl.innerHTML = data.visual;
                visualEl.classList.remove('hidden');
                if(window.Sound) window.Sound.playTone(400, 'sine', 0.2); // Popup sound
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

// --- 📊 CAPSTONE FEATURE: FULL GAME REVIEW ---
window.viewGameHistory = function() {
    if(window.Sound) window.Sound.click();
    
    const logContainer = document.getElementById("mistakes-log");
    const btn = document.getElementById("view-mistakes-btn");
    
    if (!logContainer || !btn) return;

    // TOGGLE LOGIC
    if (logContainer.classList.contains("hidden")) {
        // OPEN REVIEW
        logContainer.classList.remove("hidden");
        btn.innerText = "🔼 HIDE REVIEW";
        logContainer.innerHTML = ""; 
        
        const history = state.gameHistory || [];

        if (history.length === 0) {
            logContainer.innerHTML = `
                <div class="log-item" style="text-align:center; color:#888; padding:20px; border:1px dashed #444; font-size:14px;">
                    NO DATA RECORDED.<br>
                    <span style="font-size:12px; color:#555;">BATTLE HAS NOT STARTED.</span>
                </div>`;
        } else {
            // Sort by latest first
            history.slice().reverse().forEach((item, index) => {
                let isCorrect = item.status === 'correct';
                let color = isCorrect ? '#00ff41' : (item.status === 'missed' ? '#ff0055' : 'orange'); 
                let label = item.status.toUpperCase();
                
                // Generate Explanation
                let explanation = (window.getExplanation) ? window.getExplanation(item.q.toString(), item.a) : "Math rule.";
                let uniqueId = `rev-${index}`;

                let html = `
                    <div class="log-item" style="border-left: 4px solid ${color}; background: rgba(0,0,0,0.8); margin-bottom: 8px; padding: 12px; border-radius: 0 4px 4px 0; text-align: left; border-bottom: 1px solid #333;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="color:white; font-size:18px; font-family:'Orbitron';">
                                    ${item.q} <span style="color:#888;">=</span> <span style="color:${isCorrect?'#00ff41':'#ffd700'}">${item.a}</span>
                                </div>
                                <div style="font-size:11px; color:#aaa; margin-top:2px;">YOU TYPED: <span style="color:${isCorrect?'#fff':'#ff5555'}">${item.input}</span></div>
                            </div>
                            <div style="text-align:right;">
                                <div style="color:${color}; font-weight:bold; font-size:10px; letter-spacing:1px; margin-bottom:4px;">${label}</div>
                                <button class="btn text-only" style="padding:2px 8px; font-size:10px; border:1px solid ${color}; color:${color};" onclick="document.getElementById('${uniqueId}').classList.toggle('hidden')">
                                    ${isCorrect ? '🔍 ANALYZE' : '💡 SOLUTION'}
                                </button>
                            </div>
                        </div>
                        <div id="${uniqueId}" class="hidden" style="margin-top:10px; padding:10px; background:rgba(255, 255, 255, 0.05); border-left:2px solid ${color}; color:#ccc; font-size:12px; font-family:'Courier New'; white-space: pre-wrap;">${explanation}</div>
                    </div>`;
                logContainer.innerHTML += html;
            });
        }
    } else {
        // CLOSE REVIEW
        logContainer.classList.add("hidden");
        btn.innerText = "📂 REVIEW MISSION LOG";
    }
};

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

// 5. RENDER GRID (The Visual Cards)
window.renderShopGrid = function() {
    const grid = document.getElementById('shop-grid');
    if (!grid) return;
    grid.innerHTML = "";

    let items = shopCatalog[currentShopTab] || [];
    
    // Filter Ships Logic
    if (currentShopTab === 'ships') {
        const filterVal = document.getElementById('shop-ship-filter').value;
        items = items.filter(i => i.subtype === filterVal);
    }

    const userInv = (currentUser && currentUser.inventory) ? currentUser.inventory : ['turret_def', 'enemy_def', 'boss_def', 'fx_blue'];
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
    const allowedEmails = ["jesstergirado@gmail.com", "stockfishvshumans@gmail.com"];
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
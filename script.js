// --- CATEGORIES & DATA ---
const CATEGORIES = {
    'gdpt': 'Chương trình GDPT',
    'advanced_gdpt': '(Nâng cao) Chương trình GDPT',
    'topic': 'Từ vựng theo chủ đề'
};

const VOCAB_INDEX_URL = './vocab/index.json';
let VOCAB_SETS = [];
let vocabLoaded = false;

// Cache discovered files per folder to avoid redundant scans
const folderFileCache = {};

// Legacy fallback list (used only if automatic scan fails)
const FALLBACK_FILES = {
    'gdpt-program': [
        'family-life.json', 'life-story.json', 'school-life.json', 'friendship.json',
        'environment.json', 'global-warming.json', 'cultural-diversity.json',
        'future-jobs.json', 'cities.json', 'ecotourism.json', 'relationship.json'
    ],
    'advanced-gdpt-program': [
        'core.json', 'academic.json', 'ielts.json', 'advanced.json',
        'essay.json', 'presentation.json', 'debate.json'
    ],
    'topic-vocab': [
        'technology.json', 'business.json', 'travel.json', 'food.json',
        'health.json', 'sports.json', 'music.json', 'art.json',
        'science.json', 'education.json', 'culture.json', 'history.json',
        'politics.json', 'economy.json', 'medicine.json', 'law.json',
        'engineering.json', 'psychology.json', 'philosophy.json'
    ]
};

// --- GLOBAL STATE ---
let currentView = 'home';
let currentSet = null;
let sessionStartTime = 0;
let searchTerm = '';
let progressFilter = 'all';
let currentSessionData = []; // Data used for the current session (subset for relearn or full set)
let isRelearnMode = false;   // Flag to indicate if we are in relearn mode
let lastSessionConfig = { mode: null, dataset: 'full' }; // Track last finished session

const SESSION_STATE_KEY = 'vocab_session_state_v2';

// Game States
let fcIndex = 0;
let fcIsFlipped = false;
let fcStats = { known: 0, learning: 0 };
let sessionWrongItems = []; // Track wrong answers with source references

let matchCards = [];
let matchSelected = [];
let matchMatched = [];
let matchTimerInterval;
let matchTime = 0;
let matchCurrentBatch = 0; // Batch hiện tại (mỗi batch 10 cặp)
let matchTotalPairs = 0; // Tổng số cặp
let matchCorrectPairs = 0; // Số cặp đúng
let matchWrongAttempts = 0; // Số lần chọn sai

let learnIndex = 0;
let learnStats = { correct: 0, wrong: 0 };
let learnQuestions = [];
let isLearnAnswerLocked = false;

// User Data State
let userStats = JSON.parse(localStorage.getItem('study_stats')) || {
    totalWords: 0,
    totalMinutes: 0,
    sessions: 0,
    learnedIds: [], // Track unique learned word IDs
    weakWords: {},   // { setId: [id1, id2, ...] }
    randomHistory: {}, // { setId: [lastRandomWordIds] } - Lưu lịch sử random để tránh trùng lặp
    matchingStats: { total: 0, correct: 0 }, // Thống kê Matching
    learnStats: { total: 0, correct: 0 }    // Thống kê Learn
};

// Word selection state
let selectedWordCount = null; // null = all, number = specific count
let wordSelectionMode = 'random'; // 'random', 'first', 'next', 'unlearned', 'custom'

// --- THEME & DATA ---
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const isDark = savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches);
    
    if (isDark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
}

function toggleTheme() {
    const html = document.documentElement;
    if (html.classList.contains('dark')) {
        html.classList.remove('dark');
        localStorage.setItem('theme', 'light');
    } else {
        html.classList.add('dark');
        localStorage.setItem('theme', 'dark');
    }
}

function saveStats() { localStorage.setItem('study_stats', JSON.stringify(userStats)); }

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function saveSessionState(state) {
    if (!state || !state.setId) return;
    try {
        localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(state));
    } catch (error) {
        console.warn('Không thể lưu trạng thái phiên học:', error);
    }
}

function loadSessionStateFromStorage() {
    try {
        const raw = localStorage.getItem(SESSION_STATE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        console.warn('Không thể đọc trạng thái phiên học:', error);
        return null;
    }
}

function clearSessionState() {
    localStorage.removeItem(SESSION_STATE_KEY);
}

function persistFlashcardState() {
    if (!currentSet || !currentSet.id || !currentSessionData.length) return;
    saveSessionState({
        mode: 'flashcard',
        setId: currentSet.id,
        dataset: lastSessionConfig?.dataset || (isRelearnMode ? 'weak' : 'full'),
        isRelearnMode,
        fcIndex,
        fcStats,
        currentSessionData: deepClone(currentSessionData)
    });
}

function persistLearnState() {
    if (!currentSet || !currentSet.id || !learnQuestions.length) return;
    saveSessionState({
        mode: 'learn',
        setId: currentSet.id,
        dataset: lastSessionConfig?.dataset || (isRelearnMode ? 'weak' : 'full'),
        isRelearnMode,
        learnIndex,
        learnStats,
        learnQuestions: deepClone(learnQuestions),
        currentSessionData: deepClone(currentSessionData)
    });
}

function persistMatchingState() {
    if (!currentSet || !currentSet.id || !matchCards.length) return;
    saveSessionState({
        mode: 'matching',
        setId: currentSet.id,
        dataset: 'full',
        isRelearnMode: false,
        matchCards: deepClone(matchCards),
        matchMatched: deepClone(matchMatched),
        matchTime,
        currentSessionData: deepClone(currentSessionData)
    });
}

async function loadVocabSets() {
    if (vocabLoaded) return;
    
    // Show loading
    showLoading(true);
    
    try {
        // Load category configuration
        const response = await fetch(VOCAB_INDEX_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const indexData = await response.json();
        const categories = indexData.categories || [];
        const loadedSets = [];

        // Auto-scan: Try to fetch all possible JSON files in each folder
        for (const category of categories) {
            try {
                // Get list of files to try from a comprehensive list
                const filesToTry = await getFilesToScan(category.folder);
                
                // Try to load each file
                const loadPromises = filesToTry.map(async (filename) => {
                    try {
                        const vocabResponse = await fetch(`./vocab/${category.folder}/${filename}`);
                        if (!vocabResponse.ok) return null;
                        
                        const vocabJson = await vocabResponse.json();
                        
                        // Skip if it's not a vocab file (no words array) or is a config file
                        if (!vocabJson.words || !Array.isArray(vocabJson.words)) return null;
                        if (filename.includes('vocab-list') || filename.includes('index')) return null;
                        
                        const words = vocabJson.words;
                        if (words.length === 0) return null;

                        // Generate unique ID from folder and filename
                        const setId = `${category.folder}-${filename.replace(/\.json$/, '')}`.toLowerCase();

                        return {
                            id: setId,
                            categoryId: category.type, // Auto-determined from folder
                            title: vocabJson.name || vocabJson.title || filename.replace(/\.json$/, ''),
                            description: vocabJson.title || vocabJson.name || '',
                            color: vocabJson.color || 'indigo',
                            data: words.map(word => ({
                                ...word,
                                topicId: vocabJson.topicId || setId,
                                topicTitle: vocabJson.title || vocabJson.name
                            }))
                        };
                    } catch (fileError) {
                        return null;
                    }
                });
                
                const results = await Promise.all(loadPromises);
                loadedSets.push(...results.filter(r => r !== null));
            } catch (categoryError) {
                console.error(`Không thể tải thư mục ${category.folder}:`, categoryError);
            }
        }

        VOCAB_SETS = loadedSets;
    } catch (error) {
        console.error('Không thể tải dữ liệu từ vựng:', error);
        VOCAB_SETS = [];
    } finally {
        vocabLoaded = true;
        showLoading(false);
    }
}

// Attempt to discover JSON files in a folder so new vocab sets auto-load
async function getFilesToScan(folder) {
    if (folderFileCache[folder]) return folderFileCache[folder];

    const discoveredViaListing = await tryDirectoryListing(folder);
    if (discoveredViaListing.length) {
        folderFileCache[folder] = discoveredViaListing;
        return discoveredViaListing;
    }

    const manifestFiles = await tryFolderManifest(folder);
    if (manifestFiles.length) {
        folderFileCache[folder] = manifestFiles;
        return manifestFiles;
    }

    const fallbackFiles = await probeFallbackFiles(folder);
    folderFileCache[folder] = fallbackFiles;
    return fallbackFiles;
}

function normalizeFileList(files) {
    if (!Array.isArray(files)) return [];
    const blacklist = ['index', 'manifest', 'vocab-list'];
    const seen = new Set();
    return files
        .map(file => (typeof file === 'string' ? file.trim() : ''))
        .filter(Boolean)
        .filter(name => name.toLowerCase().endsWith('.json'))
        .filter(name => !blacklist.some(term => name.toLowerCase().includes(term)))
        .filter(name => {
            if (seen.has(name)) return false;
            seen.add(name);
            return true;
        });
}

async function tryDirectoryListing(folder) {
    const urlsToTry = [
        `./vocab/${folder}/?t=${Date.now()}`,
        `./vocab/${folder}?t=${Date.now()}`
    ];

    for (const url of urlsToTry) {
        try {
            const response = await fetch(url, {
                method: 'GET',
                cache: 'no-cache',
                headers: { 'Accept': 'text/html,application/json' }
            });
            if (!response.ok) continue;
            const contentType = response.headers.get('content-type') || '';

            // Some dev servers (e.g. Vite) can return JSON arrays for directory listing
            if (contentType.includes('application/json')) {
                const data = await response.json();
                const files = Array.isArray(data.files) ? data.files : data;
                const normalized = normalizeFileList(files);
                if (normalized.length) return normalized;
                continue;
            }

            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            const links = Array.from(doc.querySelectorAll('a[href$=".json"]'));
            const files = links.map(link => {
                const href = link.getAttribute('href') || '';
                const decoded = decodeURIComponent(href);
                return decoded.split('/').pop();
            });
            const normalized = normalizeFileList(files);
            if (normalized.length) return normalized;
        } catch (error) {
            // Ignore and try next strategy
        }
    }

    return [];
}

async function tryFolderManifest(folder) {
    const manifestCandidates = [
        `./vocab/${folder}/manifest.json`,
        `./vocab/${folder}/filelist.json`,
        `./vocab/${folder}/index.json`
    ];

    for (const url of manifestCandidates) {
        try {
            const response = await fetch(url, { method: 'GET', cache: 'no-cache' });
            if (!response.ok) continue;
            const data = await response.json();
            if (Array.isArray(data.files)) {
                const normalized = normalizeFileList(data.files);
                if (normalized.length) return normalized;
            } else if (Array.isArray(data)) {
                const normalized = normalizeFileList(data);
                if (normalized.length) return normalized;
            }
        } catch (err) {
            // Ignore and try next candidate
        }
    }

    return [];
}

async function probeFallbackFiles(folder) {
    const candidates = FALLBACK_FILES[folder] || [];
    if (!candidates.length) return [];

    const probes = candidates.map(async (filename) => {
        try {
            const response = await fetch(`./vocab/${folder}/${filename}`, { method: 'HEAD', cache: 'no-cache' });
            if (response.ok) return filename;
            // Some servers block HEAD, fall back to GET
            const getResponse = await fetch(`./vocab/${folder}/${filename}`, { method: 'GET', cache: 'no-cache' });
            if (!getResponse.ok) return null;
            const data = await getResponse.json();
            return data.words && Array.isArray(data.words) ? filename : null;
        } catch {
            return null;
        }
    });

    const results = await Promise.all(probes);
    return results.filter(Boolean);
}

// Loading UI functions
function showLoading(show) {
    const loadingEl = document.getElementById('loading-overlay');
    if (loadingEl) {
        loadingEl.style.display = show ? 'flex' : 'none';
    }
}

function trackSessionStart() { 
    sessionStartTime = Date.now(); 
    userStats.sessions++; 
    sessionWrongItems = []; // Reset wrong words for this session
    saveStats(); 
}

function trackSessionEnd() {
    if (sessionStartTime > 0) {
        const durationMs = Date.now() - sessionStartTime;
        const minutes = Math.round(durationMs / 60000);
        if (minutes > 0) { userStats.totalMinutes += minutes; saveStats(); }
        sessionStartTime = 0;
    }
}

// Updated Logic: Only count as "Learned" if not already in learnedIds
function trackWordLearned(wordId) { 
    if (!userStats.learnedIds) userStats.learnedIds = [];
    
    if (!userStats.learnedIds.includes(wordId)) {
        userStats.totalWords++; 
        userStats.learnedIds.push(wordId);
        saveStats(); 
        return true; // New word learned
    }
    return false; // Already known
}

// Logic to save weak words for relearning
function saveWeakWords() {
    if (!sessionWrongItems.length) return;
    if (!userStats.weakWords) userStats.weakWords = {};

    const grouped = {};
    sessionWrongItems.forEach(item => {
        const sourceSetId = item.sourceSetId || currentSet?.id;
        if (!sourceSetId) return;
        if (!grouped[sourceSetId]) grouped[sourceSetId] = new Set();
        grouped[sourceSetId].add(item.wordId);
    });

    Object.entries(grouped).forEach(([setId, ids]) => {
        const sourceSet = VOCAB_SETS.find(s => s.id === setId);
        if (!sourceSet) return;
        const validIds = new Set(sourceSet.data.map(d => d.id));
        const list = userStats.weakWords[setId] || [];
        const combined = new Set([...list]);

        ids.forEach(id => {
            if (validIds.has(id)) combined.add(id);
        });

        userStats.weakWords[setId] = Array.from(combined);
    });

    saveStats();
}

function clearWeakWordEntries(entries) {
    if (!userStats.weakWords || !entries || !entries.length) return;

    entries.forEach(entry => {
        const sourceSetId = entry.sourceSetId || currentSet?.id;
        const wordId = entry.wordId;
        if (!sourceSetId || wordId == null) return;
        if (!userStats.weakWords[sourceSetId]) return;

        userStats.weakWords[sourceSetId] = userStats.weakWords[sourceSetId].filter(id => id !== wordId);
    });

    saveStats();
}

function resetData() {
    if(confirm('Bạn có chắc muốn xóa toàn bộ lịch sử học tập?')) {
        userStats = { totalWords: 0, totalMinutes: 0, sessions: 0, learnedIds: [], weakWords: {} };
        saveStats();
        alert('Đã xóa dữ liệu.');
        showView('home');
    }
}

// --- VIEW MANAGEMENT ---
function showView(viewName) {
    if (currentView === 'flashcard' || currentView === 'matching' || currentView === 'learn') {
        trackSessionEnd();
        stopMatchTimer();
    }

    const container = document.getElementById('app-container');
    const template = document.getElementById(`tpl-${viewName}`);
    
    container.innerHTML = '';
    if (template) {
        container.appendChild(template.content.cloneNode(true));
    }
    currentView = viewName;

    if (viewName === 'home') {
        renderLibrary();
        document.getElementById('search-input').value = searchTerm;
    } else if (viewName === 'set-detail') {
        renderSetDetail();
    } else if (viewName === 'settings') {
        initSettingsView();
    } else if (viewName === 'stats') {
        renderStatsView();
    }
}

function initSettingsView() {
    const toggle = document.getElementById('dark-mode-toggle');
    toggle.checked = document.documentElement.classList.contains('dark');
    toggle.addEventListener('change', toggleTheme);
}

function renderStatsView() {
    document.getElementById('stats-words').textContent = userStats.totalWords;
    document.getElementById('stats-time').textContent = userStats.totalMinutes;
    document.getElementById('stats-sessions').textContent = userStats.sessions;
    
    // Calculate combined accuracy for Matching and Learn
    const matchingStats = userStats.matchingStats || { total: 0, correct: 0 };
    const learnStats = userStats.learnStats || { total: 0, correct: 0 };
    const totalAttempts = matchingStats.total + learnStats.total;
    const totalCorrect = matchingStats.correct + learnStats.correct;
    const combinedAccuracy = totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : 0;
    
    // Update accuracy display
    const accuracyEl = document.getElementById('stats-accuracy');
    if (accuracyEl) {
        accuracyEl.textContent = `${combinedAccuracy}%`;
    }
}

function getSetProgress(set) {
    if (!set) return { learned: 0, total: 0, percent: 0 };
    const total = set.data.length || 0;
    if (total === 0) return { learned: 0, total: 0, percent: 0 };

    const learnedIds = new Set(userStats.learnedIds || []);
    const learned = set.data.reduce((count, item) => count + (learnedIds.has(item.id) ? 1 : 0), 0);
    const percent = Math.round((learned / total) * 100);
    return { learned, total, percent };
}

function buildWeakReviewSet() {
    if (!userStats.weakWords) return null;
    const aggregated = [];

    Object.entries(userStats.weakWords).forEach(([setId, ids]) => {
        if (!ids || !ids.length) return;
        const baseSet = VOCAB_SETS.find(s => s.id === setId);
        if (!baseSet) return;
        ids.forEach(wordId => {
            const word = baseSet.data.find(item => item.id === wordId);
            if (word) {
                aggregated.push({ ...word, _sourceSetId: setId });
            }
        });
    });

    if (!aggregated.length) return null;

    return {
        id: 'weak-review',
        categoryId: 'weak',
        title: 'Ôn tập tổng hợp',
        description: 'Chủ đề chứa toàn bộ các từ bạn cần học lại.',
        color: 'orange',
        isDynamic: true,
        data: aggregated
    };
}

function cloneSessionDataFromSet(set) {
    if (!set?.data) return [];
    return set.data.map(item => ({ ...item }));
}

function getSourceSetIdFromItem(item) {
    return item?._sourceSetId || currentSet?.id || null;
}

function recordSessionWrong(wordId, sourceSetId) {
    if (wordId == null) return;
    sessionWrongItems.push({ wordId, sourceSetId });
}

function getUniqueSessionWrongCount() {
    const seen = new Set();
    sessionWrongItems.forEach(item => {
        const key = `${item.sourceSetId || currentSet?.id || 'default'}-${item.wordId}`;
        seen.add(key);
    });
    return seen.size;
}

function matchesProgressFilter(percent) {
    switch (progressFilter) {
        case 'completed':
            return percent === 100;
        case 'incomplete':
            return percent < 100;
        case 'gt50':
            return percent > 50 && percent < 100;
        case 'lt50':
            return percent < 50;
        default:
            return true;
    }
}

function startRelearnFromResults() {
    if (!currentSet) return;
    if (currentSet.id === 'weak-review') {
        selectSet('weak-review');
        repeatLastSession();
        return;
    }
    const preferredMode = lastSessionConfig.mode === 'learn' ? 'learn' : 'flashcard';
    startRelearn(preferredMode);
}

function repeatLastSession() {
    if (!currentSet || !lastSessionConfig.mode) return;

    let useWeakData = lastSessionConfig.dataset === 'weak';
    if (lastSessionConfig.mode === 'matching') {
        useWeakData = false; // Matching luôn chơi cả bộ
    }

    if (useWeakData) {
        if (currentSet.id === 'weak-review') {
            const rebuilt = resolveSet('weak-review');
            if (!rebuilt || !rebuilt.data.length) {
                alert('Bạn đã hoàn thành hết các từ cần ôn. Sẽ học lại toàn bộ bộ từ.');
                useWeakData = false;
            } else {
                const normalizedData = rebuilt.data.map(item => ({
                    ...item,
                    _sourceSetId: item._sourceSetId || rebuilt.id
                }));
                currentSet = { ...rebuilt, data: normalizedData };
                currentSessionData = cloneSessionDataFromSet(currentSet);
            }
        } else {
            const weakIds = userStats.weakWords?.[currentSet.id] || [];
            if (!weakIds.length) {
                alert('Bạn đã hoàn thành hết các từ cần ôn. Sẽ học lại toàn bộ bộ từ.');
                useWeakData = false;
            } else {
                currentSessionData = currentSet.data.filter(d => weakIds.includes(d.id));
            }
        }
    }

    if (!useWeakData) {
        currentSessionData = cloneSessionDataFromSet(currentSet);
    }

    isRelearnMode = useWeakData;

    switch (lastSessionConfig.mode) {
        case 'learn':
            startLearn();
            break;
        case 'matching':
            startMatching();
            break;
        default:
            startFlashcards();
    }
}

function updateRepeatButton() {
    const repeatBtn = document.getElementById('btn-repeat-session');
    if (!repeatBtn) return;

    if (!lastSessionConfig.mode || !currentSet) {
        repeatBtn.classList.add('hidden');
        return;
    }

    const modeLabels = {
        flashcard: 'Flashcards',
        learn: 'Learn',
        matching: 'Matching'
    };

    repeatBtn.textContent = `Học lại (${modeLabels[lastSessionConfig.mode] || 'Ôn tập'})`;
    repeatBtn.classList.remove('hidden');
}

// --- SEARCH & LIBRARY ---
function handleSearch(val) {
    searchTerm = val.toLowerCase();
    renderLibrary();
}

function resumeSessionIfAvailable() {
    const savedState = loadSessionStateFromStorage();
    if (!savedState) {
        showView('home');
        return;
    }

    let resumed = false;
    switch (savedState.mode) {
        case 'flashcard':
            resumed = resumeFlashcardSession(savedState);
            break;
        case 'learn':
            resumed = resumeLearnSession(savedState);
            break;
        case 'matching':
            resumed = resumeMatchingSession(savedState);
            break;
        default:
            resumed = false;
    }

    if (!resumed) {
        clearSessionState();
        showView('home');
    }
}

function resumeFlashcardSession(state) {
    const set = resolveSet(state.setId);
    if (!set) return false;
    currentSet = { ...set, data: cloneSessionDataFromSet(set) };
    currentSessionData = state.currentSessionData ? deepClone(state.currentSessionData) : cloneSessionDataFromSet(currentSet);
    if (!currentSessionData.length) return false;
    isRelearnMode = !!state.isRelearnMode;
    lastSessionConfig = { mode: 'flashcard', dataset: state.dataset || (isRelearnMode ? 'weak' : 'full') };
    fcIndex = Math.min(state.fcIndex || 0, currentSessionData.length - 1);
    fcStats = state.fcStats || { known: 0, learning: 0 };
    fcIsFlipped = false;
    sessionStartTime = Date.now();
    showView('flashcard');
    updateFlashcardUI();
    return true;
}

function resumeLearnSession(state) {
    const set = resolveSet(state.setId);
    if (!set) return false;
    currentSet = { ...set, data: cloneSessionDataFromSet(set) };
    currentSessionData = state.currentSessionData ? deepClone(state.currentSessionData) : cloneSessionDataFromSet(currentSet);
    learnQuestions = state.learnQuestions ? deepClone(state.learnQuestions) : [];
    if (!learnQuestions.length || !currentSessionData.length) return false;
    isRelearnMode = !!state.isRelearnMode;
    lastSessionConfig = { mode: 'learn', dataset: state.dataset || (isRelearnMode ? 'weak' : 'full') };
    learnIndex = Math.min(state.learnIndex || 0, learnQuestions.length - 1);
    learnStats = state.learnStats || { correct: 0, wrong: 0 };
    isLearnAnswerLocked = false;
    sessionStartTime = Date.now();
    showView('learn');
    renderLearnQuestion();
    return true;
}

function resumeMatchingSession(state) {
    const set = resolveSet(state.setId);
    if (!set) return false;
    currentSet = { ...set, data: cloneSessionDataFromSet(set) };
    currentSessionData = state.currentSessionData ? deepClone(state.currentSessionData) : cloneSessionDataFromSet(currentSet);
    matchCards = state.matchCards ? deepClone(state.matchCards) : [];
    matchMatched = state.matchMatched ? deepClone(state.matchMatched) : [];
    if (!matchCards.length) return false;
    matchSelected = [];
    matchTime = state.matchTime || 0;
    isRelearnMode = false;
    lastSessionConfig = { mode: 'matching', dataset: 'full' };
    showView('matching');
    renderMatchingGridFromCards();
    startMatchTimer();
    return true;
}

function renderMatchingGridFromCards() {
    const grid = document.getElementById('matching-grid');
    if (!grid) return;
    grid.innerHTML = '';
    matchCards.forEach(card => {
        const el = document.createElement('div');
        const isMatched = matchMatched.includes(card.id);
        if (isMatched) {
            el.className = 'bg-green-100 dark:bg-green-900/30 border-2 border-green-500 dark:border-green-600 text-green-700 dark:text-green-300 rounded-2xl p-2 md:p-3 flex items-center justify-center text-center h-full font-bold anim-correct text-xs md:text-sm shadow-inner';
        } else {
            el.className = 'bg-white dark:bg-dark-card border-2 border-slate-200 dark:border-slate-700 rounded-2xl p-2 md:p-3 flex items-center justify-center text-center cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-600 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all select-none h-full font-medium text-slate-700 dark:text-slate-200 active:scale-95 text-xs md:text-sm btn-press shadow-sm break-words';
            el.onclick = () => handleMatchClick(card.id, card.refId, el);
        }
        el.textContent = card.content;
        grid.appendChild(el);
    });
    const timerEl = document.getElementById('match-timer');
    if (timerEl) {
        timerEl.textContent = formatTime(matchTime);
    }
}

function renderLibrary() {
    const container = document.getElementById('library-container');
    const emptyState = document.getElementById('search-empty');
    if (!container) return;

    const filterSelect = document.getElementById('progress-filter');
    if (filterSelect) {
        filterSelect.value = progressFilter;
        filterSelect.onchange = (e) => {
            progressFilter = e.target.value;
            renderLibrary();
        };
    }
    
    container.innerHTML = '';
    let hasResults = false;

    const weakReviewSet = buildWeakReviewSet();
    if (weakReviewSet) {
        const q = (searchTerm || '').toLowerCase();
        const weakProgress = getSetProgress(weakReviewSet);
        const matchesWeakSearch = !searchTerm ||
            weakReviewSet.title.toLowerCase().includes(q) ||
            weakReviewSet.description.toLowerCase().includes(q);
        const matchesWeakFilter = matchesProgressFilter(weakProgress.percent);

        if (matchesWeakSearch && matchesWeakFilter) {
            hasResults = true;
            const section = document.createElement('div');
            section.className = 'w-full mb-6';

            const header = document.createElement('h3');
            header.className = 'text-lg font-bold text-orange-600 dark:text-orange-300 mb-3 flex items-center gap-2';
            header.innerHTML = `<span class="w-1.5 h-6 bg-orange-400 rounded-full"></span> Chủ đề Ôn tập`;
            section.appendChild(header);

            const card = document.createElement('div');
            card.className = 'bg-orange-50 dark:bg-orange-900/20 p-5 rounded-2xl border border-orange-100 dark:border-orange-900/40 hover:border-orange-300 dark:hover:border-orange-700 transition-all cursor-pointer btn-press shadow-sm flex flex-col gap-3';
            card.onclick = () => selectSet(weakReviewSet);

            card.innerHTML = `
                <div class="flex items-center justify-between">
                    <span class="text-xs font-bold uppercase tracking-wide text-orange-600 dark:text-orange-300">${weakReviewSet.data.length} từ cần ôn</span>
                    <i class="ph ph-arrow-right text-orange-500 dark:text-orange-200"></i>
                </div>
                <div>
                    <h4 class="text-xl font-bold text-slate-800 dark:text-white mb-1">${weakReviewSet.title}</h4>
                    <p class="text-sm text-slate-500 dark:text-slate-400">${weakReviewSet.description}</p>
                </div>
                <div>
                    <div class="flex items-center justify-between text-xs text-orange-700 dark:text-orange-200 mb-1">
                        <span>Tiến độ</span>
                        <span class="font-bold">${weakReviewSet.data.length} từ chưa thuộc</span>
                    </div>
                    <div class="w-full h-2 bg-orange-100 dark:bg-orange-950/40 rounded-full overflow-hidden">
                        <div class="h-full bg-orange-400 rounded-full" style="width: 100%;"></div>
                    </div>
                </div>
            `;

            section.appendChild(card);
            container.appendChild(section);
        }
    }

    Object.keys(CATEGORIES).forEach(catKey => {
        const sets = VOCAB_SETS.filter(s => 
            s.categoryId === catKey && 
            (s.title.toLowerCase().includes(searchTerm) || s.description.toLowerCase().includes(searchTerm))
        );
        
        if (sets.length > 0) {
            const section = document.createElement('div');
            section.className = 'w-full';
            
            const header = document.createElement('h3');
            header.className = 'text-lg font-bold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2';
            header.innerHTML = `<span class="w-1.5 h-6 bg-indigo-500 rounded-full"></span> ${CATEGORIES[catKey]}`;
            section.appendChild(header);

            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4';
            let categoryHasResults = false;

            sets.forEach(set => {
                const card = document.createElement('div');
                const progress = getSetProgress(set);
                if (!matchesProgressFilter(progress.percent)) return;
                categoryHasResults = true;
                const isComplete = progress.percent === 100;
                const showProgress = progress.percent > 0 && progress.percent < 100;

                let cardClasses = 'p-4 md:p-5 rounded-2xl shadow-sm transition-all cursor-pointer btn-press relative overflow-hidden flex flex-col justify-between h-full';
                if (isComplete) {
                    cardClasses += ' bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 hover:border-emerald-400 dark:hover:border-emerald-500';
                } else {
                    cardClasses += ` bg-white dark:bg-dark-card border border-slate-100 dark:border-slate-700 hover:shadow-lg hover:border-${set.color}-200 dark:hover:border-${set.color}-800`;
                }
                card.className = cardClasses;
                card.onclick = () => selectSet(set.id);
                
                card.innerHTML = `
                    <div>
                        <div class="flex justify-between items-start mb-2">
                            ${isComplete
                                ? `<div class="flex items-center gap-1 text-emerald-600 dark:text-emerald-300 text-[11px] font-bold uppercase tracking-wider"><i class="ph-fill ph-check-circle"></i><span>ĐÃ HOÀN THÀNH</span></div>`
                                : `<span class="px-2 py-0.5 rounded bg-${set.color}-50 dark:bg-${set.color}-900/30 text-${set.color}-600 dark:text-${set.color}-300 text-[10px] font-bold uppercase tracking-wider">${set.data.length} thẻ</span>`
                            }
                            <i class="ph ph-caret-right ${isComplete ? 'text-emerald-400' : 'text-slate-300 dark:text-slate-600'}"></i>
                        </div>
                        <h4 class="text-lg font-bold text-slate-800 dark:text-white mb-1 line-clamp-2">${set.title}</h4>
                        <p class="text-sm text-slate-500 dark:text-slate-400 line-clamp-2">${set.description}</p>
                    </div>
                    ${showProgress ? `
                    <div class="mt-4">
                        <div class="flex items-center justify-between text-xs text-slate-400 dark:text-slate-500 mb-1">
                            <span>Tiến độ</span>
                            <span class="font-bold text-slate-700 dark:text-slate-200">${progress.percent}%</span>
                        </div>
                        <div class="w-full h-2 ${isComplete ? 'bg-emerald-100 dark:bg-emerald-800/40' : 'bg-slate-100 dark:bg-slate-800'} rounded-full overflow-hidden">
                            <div class="h-full rounded-full ${isComplete ? 'bg-emerald-500 dark:bg-emerald-400' : `bg-${set.color}-500 dark:bg-${set.color}-400`} transition-all duration-300" style="width: ${progress.percent}%;"></div>
                        </div>
                    </div>` : ''}
                `;
                grid.appendChild(card);
            });

            if (categoryHasResults) {
                hasResults = true;
                section.appendChild(grid);
                container.appendChild(section);
            }
        }
    });

    if (!hasResults && searchTerm) {
        emptyState.style.display = 'flex';
        setTimeout(() => emptyState.style.opacity = 1, 10);
    } else {
        emptyState.style.display = 'none';
        emptyState.style.opacity = 0;
    }
}

function resolveSet(setOrId) {
    if (!setOrId) return null;
    if (typeof setOrId === 'object') return setOrId;
    if (setOrId === 'weak-review') return buildWeakReviewSet();
    return VOCAB_SETS.find(s => s.id === setOrId) || null;
}

function selectSet(setOrId) {
    const set = resolveSet(setOrId);
    if (!set) return;

    const normalizedData = set.data.map(item => ({
        ...item,
        _sourceSetId: item._sourceSetId || set.id
    }));

    currentSet = { ...set, data: normalizedData };
    currentSessionData = cloneSessionDataFromSet(currentSet);
    isRelearnMode = false;
    updateRepeatButton();
    showView('set-detail');
}

function renderSetDetail() {
    if (!currentSet) return showView('home');
    document.getElementById('detail-title').textContent = currentSet.title;
    document.getElementById('detail-desc').textContent = currentSet.description;
    document.getElementById('detail-count').textContent = `${currentSet.data.length} thuật ngữ`;
    const progress = getSetProgress(currentSet);
    const progressText = document.getElementById('detail-progress');
    const progressBar = document.getElementById('detail-progress-bar');
    const progressWrapper = document.getElementById('detail-progress-wrapper');
    const completeBadge = document.getElementById('detail-complete-badge');
    const showProgress = progress.percent > 0 && progress.percent < 100;
    if (progressText) {
        progressText.textContent = `Tiến độ: ${progress.percent}% (${progress.learned}/${progress.total})`;
    }
    if (progressBar) {
        progressBar.style.width = `${progress.percent}%`;
    }
    if (progressWrapper) {
        progressWrapper.classList.toggle('hidden', !showProgress);
    }
    if (completeBadge) {
        completeBadge.classList.toggle('hidden', progress.percent !== 100);
    }

    // Check for weak words
    const relearnSection = document.getElementById('relearn-section');
    if (relearnSection) {
        if (currentSet.id === 'weak-review') {
            relearnSection.classList.add('hidden');
        } else {
            const weakIds = userStats.weakWords?.[currentSet.id] || [];
            if (weakIds.length > 0) {
                relearnSection.classList.remove('hidden');
                document.getElementById('relearn-count').textContent = weakIds.length;
            } else {
                relearnSection.classList.add('hidden');
            }
        }
    }

    // Reset word selection when viewing set detail
    selectedWordCount = null;
    wordSelectionMode = 'random';
    updateSelectedCountDisplay();
    updateWordCountButtons();
}

// --- WORD SELECTION FUNCTIONS ---
function setWordSelection(mode, count) {
    wordSelectionMode = mode;
    selectedWordCount = count;
    updateSelectedCountDisplay();
    updateWordCountButtons();
}

function showCustomCountInput() {
    const inputDiv = document.getElementById('custom-count-input');
    if (inputDiv) {
        inputDiv.classList.remove('hidden');
        const input = document.getElementById('custom-word-count');
        if (input) {
            input.focus();
            input.value = selectedWordCount || '';
        }
    }
}

function applyCustomCount() {
    const input = document.getElementById('custom-word-count');
    if (!input) return;
    const count = parseInt(input.value);
    if (count && count > 0) {
        setWordSelection('random', count);
        const inputDiv = document.getElementById('custom-count-input');
        if (inputDiv) inputDiv.classList.add('hidden');
    } else {
        alert('Vui lòng nhập số từ hợp lệ (lớn hơn 0)');
    }
}

function updateSelectedCountDisplay() {
    const display = document.getElementById('selected-count-text');
    if (!display) return;
    
    if (!currentSet) {
        display.textContent = 'Chưa chọn';
        return;
    }

    const totalWords = currentSet.data.length;
    let text = '';

    if (wordSelectionMode === 'all' || selectedWordCount === null) {
        text = `Tất cả ${totalWords} từ`;
    } else if (wordSelectionMode === 'unlearned') {
        const learnedIds = new Set(userStats.learnedIds || []);
        const unlearned = currentSet.data.filter(w => !learnedIds.has(w.id));
        text = `${unlearned.length} từ chưa học`;
    } else {
        text = `${Math.min(selectedWordCount, totalWords)} từ (ngẫu nhiên)`;
    }

    display.textContent = text;
}

function updateWordCountButtons() {
    const buttons = document.querySelectorAll('.word-count-btn');
    buttons.forEach(btn => {
        const onclick = btn.getAttribute('onclick') || '';
        let isActive = false;
        
        // Check based on mode and count
        if (wordSelectionMode === 'all' && onclick.includes("'all'")) {
            isActive = true;
        } else if (wordSelectionMode === 'random' && onclick.includes("'random'") && onclick.includes(selectedWordCount)) {
            isActive = true;
        } else if (wordSelectionMode === 'unlearned' && onclick.includes("'unlearned'")) {
            isActive = true;
        }
        
        if (isActive) {
            btn.classList.add('border-indigo-500', 'bg-indigo-100', 'dark:bg-indigo-900/30', 'text-indigo-700', 'dark:text-indigo-300');
            btn.classList.remove('border-slate-200', 'dark:border-slate-700', 'bg-slate-50', 'dark:bg-slate-800');
        } else {
            btn.classList.remove('border-indigo-500', 'bg-indigo-100', 'dark:bg-indigo-900/30', 'text-indigo-700', 'dark:text-indigo-300');
            btn.classList.add('border-slate-200', 'dark:border-slate-700', 'bg-slate-50', 'dark:bg-slate-800');
        }
    });
}

function getSelectedWords() {
    if (!currentSet) return [];

    let sourceWords = [...currentSet.data];
    const totalWords = sourceWords.length;

    // Filter based on mode
    if (wordSelectionMode === 'unlearned') {
        const learnedIds = new Set(userStats.learnedIds || []);
        sourceWords = sourceWords.filter(w => !learnedIds.has(w.id));
    }

    // Apply count limit
    if (wordSelectionMode === 'all' || selectedWordCount === null) {
        // All words, but apply smart random if needed
        return applySmartRandom(sourceWords, totalWords);
    } else {
        // Specific count with smart random
        return applySmartRandom(sourceWords, selectedWordCount);
    }
}

function applySmartRandom(words, targetCount) {
    if (words.length <= targetCount) {
        // Not enough words, return all shuffled
        return shuffleArray([...words]);
    }

    const setId = currentSet?.id;
    if (!setId) {
        // No set ID, just random
        return shuffleArray([...words]).slice(0, targetCount);
    }

    // Get previous random history
    const history = userStats.randomHistory?.[setId] || [];
    const maxOverlap = Math.floor(targetCount * 0.2); // 20% max overlap

    // Separate words into: previously used and new
    const historySet = new Set(history);
    const previouslyUsed = words.filter(w => historySet.has(w.id));
    const newWords = words.filter(w => !historySet.has(w.id));

    // Calculate how many from each group
    let fromPrevious = Math.min(previouslyUsed.length, maxOverlap);
    let fromNew = targetCount - fromPrevious;

    // If not enough new words, use more from previous
    if (fromNew > newWords.length) {
        fromPrevious = targetCount - newWords.length;
        fromNew = newWords.length;
    }

    // Select words
    const selected = [];
    
    // Add from new words (random)
    if (fromNew > 0) {
        const shuffledNew = shuffleArray([...newWords]);
        selected.push(...shuffledNew.slice(0, fromNew));
    }

    // Add from previous words (random, limited to 20%)
    if (fromPrevious > 0) {
        const shuffledPrevious = shuffleArray([...previouslyUsed]);
        selected.push(...shuffledPrevious.slice(0, fromPrevious));
    }

    // Shuffle final selection
    const finalSelection = shuffleArray(selected);

    // Update history (keep last N words to avoid too much memory)
    const maxHistorySize = 100;
    const newHistory = [...finalSelection.map(w => w.id), ...history].slice(0, maxHistorySize);
    if (!userStats.randomHistory) userStats.randomHistory = {};
    userStats.randomHistory[setId] = newHistory;
    saveStats();

    return finalSelection;
}

function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// --- LEARN MODE LOGIC ---
function startLearn() {
    if (!currentSet) return;

    const autoRelearn = currentSet.id === 'weak-review';
    const shouldReuseData = (isRelearnMode || autoRelearn) && currentSessionData.length > 0;
    if (!shouldReuseData) {
        // Use selected words if available, otherwise use all words
        currentSessionData = getSelectedWords();
        if (currentSessionData.length === 0) {
            currentSessionData = cloneSessionDataFromSet(currentSet);
        }
    }
    isRelearnMode = isRelearnMode || autoRelearn;

    if (currentSessionData.length === 0) {
        alert('Không có thuật ngữ để học.');
        return;
    }

    learnIndex = 0;
    learnStats = { correct: 0, wrong: 0 };
    lastSessionConfig = { mode: 'learn', dataset: isRelearnMode ? 'weak' : 'full' };
    
    // Randomize question order
    learnQuestions = currentSessionData.map(item => ({
        ...item,
        isEngToViet: Math.random() > 0.5
    })).sort(() => 0.5 - Math.random());

    trackSessionStart();
    showView('learn');
    renderLearnQuestion();
}

function startRelearn(preferredMode = 'flashcard') {
    if (!currentSet) return;
    const weakIds = userStats.weakWords?.[currentSet.id] || [];
    if (weakIds.length === 0) {
        alert('Hiện chưa có từ nào cần học lại.');
        return;
    }

    currentSessionData = currentSet.data.filter(d => weakIds.includes(d.id));
    if (currentSessionData.length === 0) {
        alert('Không tìm thấy từ cần ôn thuộc bộ này.');
        return;
    }

    isRelearnMode = true;
    const normalizedMode = preferredMode === 'learn' ? 'learn' : 'flashcard';
    if (normalizedMode === 'learn') {
        startLearn();
    } else {
        startFlashcards();
    }
}

function renderLearnQuestion() {
    const q = learnQuestions[learnIndex];
    isLearnAnswerLocked = false;

    document.getElementById('learn-counter').textContent = `${learnIndex + 1}/${learnQuestions.length}`;
    const percent = ((learnIndex) / learnQuestions.length) * 100;
    document.getElementById('learn-progress-bar').style.width = `${percent}%`;

    const qTypeEl = document.getElementById('learn-q-type');
    const qTextEl = document.getElementById('learn-question');
    
    if (q.isEngToViet) {
        qTypeEl.textContent = 'Thuật ngữ (Tiếng Anh)';
        qTextEl.textContent = q.word;
    } else {
        qTypeEl.textContent = 'Định nghĩa (Tiếng Việt)';
        qTextEl.textContent = q.meaning;
    }

    const optionsGrid = document.getElementById('learn-options');
    optionsGrid.innerHTML = '';

    // Distractors logic
    let distractors = currentSet.data
        .filter(item => item.id !== q.id)
        .sort(() => 0.5 - Math.random())
        .slice(0, 3);
    
    if (distractors.length < 3) {
            const otherWords = VOCAB_SETS
            .filter(s => s.id !== currentSet.id)
            .flatMap(s => s.data)
            .sort(() => 0.5 - Math.random())
            .slice(0, 3 - distractors.length);
            distractors = [...distractors, ...otherWords];
    }

    const options = [q, ...distractors].sort(() => 0.5 - Math.random());

    options.forEach((opt, idx) => {
        const btn = document.createElement('button');
        // OPTIMIZED COLORS FOR LIGHT MODE: bg-white instead of slate-50, border-slate-200, shadow-sm
        btn.className = 'w-full p-4 rounded-xl text-left bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 shadow-sm hover:border-indigo-400 dark:hover:border-cyan-800 transition-all font-medium text-slate-700 dark:text-slate-300 text-sm md:text-base btn-press relative overflow-hidden';
        
        btn.textContent = q.isEngToViet ? opt.meaning : opt.word;
        
        btn.onclick = () => handleLearnAnswer(opt.id, q, btn);
        optionsGrid.appendChild(btn);
    });
}

function handleLearnAnswer(selectedId, questionItem, btn) {
    if (isLearnAnswerLocked) return;
    isLearnAnswerLocked = true;

    const correctId = questionItem.id;
    const sourceSetId = questionItem._sourceSetId || currentSet?.id;
    const isCorrect = selectedId === correctId;
    
    if (isCorrect) {
        btn.classList.add('anim-correct');
        learnStats.correct++;
        trackWordLearned(correctId);
        // If correct in relearn mode, remove from weak words
        if(isRelearnMode) clearWeakWordEntries([{ wordId: correctId, sourceSetId }]);
    } else {
        btn.classList.add('anim-wrong');
        learnStats.wrong++;
        recordSessionWrong(correctId, sourceSetId);
    }

    setTimeout(() => {
        learnIndex++;
        if (learnIndex < learnQuestions.length) {
            renderLearnQuestion();
        } else {
            finishLearn();
        }
    }, 1000);
}

function finishLearn() {
    saveWeakWords(); // Save any wrong words to persistent storage
    
    // Calculate accuracy
    const totalQuestions = learnQuestions.length;
    const accuracy = totalQuestions > 0 ? Math.round((learnStats.correct / totalQuestions) * 100) : 0;
    
    // Update stats
    if (!userStats.learnStats) userStats.learnStats = { total: 0, correct: 0 };
    userStats.learnStats.total += totalQuestions;
    userStats.learnStats.correct += learnStats.correct;
    saveStats();
    
    showView('result');
    document.getElementById('learn-progress-bar').style.width = `100%`;
    
    // Show stats with accuracy
    const statsBlock = document.getElementById('result-stats-block');
    if (statsBlock) {
        statsBlock.style.display = 'grid';
        statsBlock.innerHTML = `
            <div class="bg-green-50 dark:bg-green-900/20 p-3 rounded-2xl border border-green-100 dark:border-green-900/30">
                <div class="text-2xl font-bold text-green-600 dark:text-green-400">${learnStats.correct}/${totalQuestions}</div>
                <div class="text-[10px] text-green-800 dark:text-green-300 uppercase font-bold tracking-wider">Câu đúng</div>
            </div>
            <div class="bg-indigo-50 dark:bg-indigo-900/20 p-3 rounded-2xl border border-indigo-100 dark:border-indigo-900/30">
                <div class="text-2xl font-bold text-indigo-600 dark:text-indigo-400">${accuracy}%</div>
                <div class="text-[10px] text-indigo-800 dark:text-indigo-300 uppercase font-bold tracking-wider">Tỉ lệ chính xác</div>
            </div>
        `;
    }

    // Show Relearn button if there were errors
    const btnRelearn = document.getElementById('btn-relearn');
    const uniqueWrongCount = getUniqueSessionWrongCount();
    if (learnStats.wrong > 0 || uniqueWrongCount > 0) {
        btnRelearn.classList.remove('hidden');
        btnRelearn.textContent = `Học lại ${uniqueWrongCount} từ chưa thuộc`;
    } else {
        btnRelearn.classList.add('hidden');
    }

    let msg = `Bạn làm đúng ${learnStats.correct}/${totalQuestions} câu.`;
    if (learnStats.correct === totalQuestions) msg = "Tuyệt đối! Bạn đã nắm vững bài học.";
    else if (learnStats.correct > learnStats.wrong) msg = "Làm tốt lắm! Hãy cố gắng hơn.";
    
    document.getElementById('result-message').textContent = msg;
    isRelearnMode = false;
    currentSessionData = cloneSessionDataFromSet(currentSet);
    updateRepeatButton();
}

// --- FLASHCARD & MATCHING ---
function startFlashcards() {
    if (!currentSet) return;
    // Note: If coming from startRelearn(), currentSessionData is already filtered.
    // If clicking "Flashcards" directly, ensure we reset to full set if not in relearn mode
    const autoRelearn = currentSet.id === 'weak-review';
    const shouldReuseData = (isRelearnMode || autoRelearn) && currentSessionData.length > 0;
    if (!shouldReuseData) {
        // Use selected words if available, otherwise use all words
        currentSessionData = getSelectedWords();
        if (currentSessionData.length === 0) {
            currentSessionData = cloneSessionDataFromSet(currentSet);
        }
    }
    isRelearnMode = isRelearnMode || autoRelearn;

    if (currentSessionData.length === 0) {
        alert('Không có thuật ngữ để học.');
        return;
    }

    lastSessionConfig = { mode: 'flashcard', dataset: isRelearnMode ? 'weak' : 'full' };

    fcIndex = 0; fcIsFlipped = false; fcStats = { known: 0, learning: 0 };
    trackSessionStart(); 
    showView('flashcard'); 
    updateFlashcardUI(); 
    initDragEvents();
}

function updateFlashcardUI() {
    const data = currentSessionData[fcIndex]; 
    if (!data) return;
    
    const card = document.getElementById('flashcard');
    card.style.transform = ''; 
    card.classList.remove('rotate-y-180', 'no-transition'); 
    card.classList.add('card-transition');
    
    document.getElementById('label-left').style.opacity = '0'; 
    document.getElementById('label-right').style.opacity = '0'; 
    card.style.borderColor = ''; 
    fcIsFlipped = false;
    
    document.getElementById('fc-word').textContent = data.word; 
    document.getElementById('fc-ipa').textContent = data.ipa;
    document.getElementById('fc-type').textContent = data.type; 
    document.getElementById('fc-meaning').textContent = data.meaning;
    document.getElementById('fc-example').textContent = `"${data.example}"`;
    document.getElementById('fc-progress').textContent = `${fcIndex + 1} / ${currentSessionData.length}`;
    
    document.getElementById('stat-known').textContent = fcStats.known; 
    document.getElementById('stat-learning').textContent = fcStats.learning;
}

function initDragEvents() {
    const card = document.getElementById('flashcard'); if (!card) return;
    let startX = 0, currentX = 0, isDragging = false, pendingTap = false;
    const startDrag = (e) => {
        if (e.target.closest('button')) return;
        isDragging = true;
        pendingTap = false;
        startX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
        card.classList.remove('card-transition');
        card.classList.add('no-transition');
    };
    const moveDrag = (e) => {
        if (!isDragging) return;
        currentX = (e.type.includes('mouse') ? e.clientX : e.touches[0].clientX) - startX;
        const rotate = currentX * 0.05;
        card.style.transform = `translateX(${currentX}px) rotate(${rotate}deg) ${fcIsFlipped ? 'rotateY(180deg)' : ''}`;
        const opacity = Math.min(Math.abs(currentX) / 100, 1);
        if (currentX > 0) {
            document.getElementById('label-right').style.opacity = opacity;
            document.getElementById('label-left').style.opacity = 0;
            card.style.borderColor = `rgba(34, 197, 94, ${opacity})`;
        } else {
            document.getElementById('label-left').style.opacity = opacity;
            document.getElementById('label-right').style.opacity = 0;
            card.style.borderColor = `rgba(239, 68, 68, ${opacity})`;
        }
    };
    const endDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        card.classList.remove('no-transition');
        card.classList.add('card-transition');
        card.style.borderColor = '';
        if (currentX > 80) {
            pendingTap = false;
            processSwipe('right');
        } else if (currentX < -80) {
            pendingTap = false;
            processSwipe('left');
        } else {
            pendingTap = Math.abs(currentX) < 5;
            card.style.transform = fcIsFlipped ? 'rotateY(180deg)' : '';
            document.getElementById('label-left').style.opacity = 0;
            document.getElementById('label-right').style.opacity = 0;
        }
        currentX = 0;
    };
    card.addEventListener('mousedown', startDrag); window.addEventListener('mousemove', moveDrag); window.addEventListener('mouseup', endDrag);
    card.addEventListener('touchstart', startDrag, { passive: true }); card.addEventListener('touchmove', moveDrag, { passive: true }); card.addEventListener('touchend', endDrag);
    card.addEventListener('click', (e) => {
        if (pendingTap) {
            e.preventDefault();
            pendingTap = false;
            toggleFlip();
        }
    });
}

function toggleFlip() { const card = document.getElementById('flashcard'); card.style.transform = `translateX(0) rotate(0deg) ${fcIsFlipped ? '' : 'rotateY(180deg)'}`; fcIsFlipped = !fcIsFlipped; }
function triggerSwipe(dir) { const card = document.getElementById('flashcard'); card.classList.add('card-transition'); const moveX = dir === 'right' ? window.innerWidth : -window.innerWidth; const rotate = dir === 'right' ? 20 : -20; card.style.transform = `translateX(${moveX}px) rotate(${rotate}deg)`; setTimeout(() => processSwipe(dir), 300); }

function processSwipe(dir) { 
    if (!currentSet) return; 
    const currentCard = currentSessionData[fcIndex];
    if (!currentCard) return;
    const currentWordId = currentCard.id;
    const sourceSetId = getSourceSetIdFromItem(currentCard);

    if (dir === 'right') { 
        fcStats.known++; 
        trackWordLearned(currentWordId); 
        if(isRelearnMode) clearWeakWordEntries([{ wordId: currentWordId, sourceSetId }]);
    } else { 
        fcStats.learning++; 
        recordSessionWrong(currentWordId, sourceSetId);
    } 
    
    fcIndex++; 
    if (fcIndex < currentSessionData.length) setTimeout(updateFlashcardUI, 50); 
    else finishFlashcards(); 
}

function finishFlashcards() { 
    saveWeakWords();

    showView('result'); 
    document.getElementById('res-known').textContent = fcStats.known; 
    document.getElementById('res-learning').textContent = fcStats.learning; 
    document.getElementById('result-stats-block').style.display = 'grid'; 
    
    const btnRelearn = document.getElementById('btn-relearn');
    const uniqueWrongCount = getUniqueSessionWrongCount();
    if (fcStats.learning > 0 || uniqueWrongCount > 0) {
        btnRelearn.classList.remove('hidden');
        btnRelearn.textContent = `Học lại ${uniqueWrongCount} từ chưa thuộc`;
    } else {
        btnRelearn.classList.add('hidden');
    }

    document.getElementById('result-message').textContent = fcStats.known === currentSessionData.length ? "Tuyệt đỉnh! Đã thuộc hết." : "Cố lên! Ôn lại các từ chưa thuộc nhé."; 
    
    // Reset mode
    isRelearnMode = false;
    currentSessionData = cloneSessionDataFromSet(currentSet);
    updateRepeatButton();
}

function startMatching() { 
    if (!currentSet) return; 
    // Use selected words if available, otherwise use all words
    currentSessionData = getSelectedWords();
    if (currentSessionData.length === 0) {
        currentSessionData = cloneSessionDataFromSet(currentSet);
    }
    if (currentSessionData.length === 0) {
        alert('Không có thuật ngữ để chơi Matching.');
        return;
    }
    isRelearnMode = false;
    lastSessionConfig = { mode: 'matching', dataset: currentSet.id === 'weak-review' ? 'weak' : 'full' };
    trackSessionStart(); 
    showView('matching'); 
    matchSelected = []; 
    matchMatched = []; 
    matchTime = 0;
    matchCurrentBatch = 0;
    matchTotalPairs = currentSessionData.length;
    matchCorrectPairs = 0;
    matchWrongAttempts = 0;
    startMatchTimer(); 
    
    // Create all cards
    let cards = []; 
    currentSessionData.forEach(item => { 
        cards.push({ id: `w-${item.id}`, refId: item.id, content: item.word }); 
        cards.push({ id: `m-${item.id}`, refId: item.id, content: item.meaning }); 
    }); 
    matchCards = cards.sort(() => Math.random() - 0.5);
    
    // Display first batch (10 pairs = 20 cards)
    renderMatchingBatch();
}

function renderMatchingBatch() {
    const grid = document.getElementById('matching-grid');
    if (!grid) return;
    
    grid.innerHTML = '';
    
    const BATCH_SIZE = 10; // 10 pairs = 20 cards
    const startIndex = matchCurrentBatch * BATCH_SIZE * 2;
    const endIndex = Math.min(startIndex + BATCH_SIZE * 2, matchCards.length);
    const batchCards = matchCards.slice(startIndex, endIndex);
    
    // Show progress
    const progressText = document.getElementById('match-progress');
    if (progressText) {
        const currentPairs = Math.floor(matchMatched.length / 2);
        progressText.textContent = `${currentPairs}/${matchTotalPairs} cặp`;
    }
    
    batchCards.forEach(card => {
        const isMatched = matchMatched.includes(card.id);
        const el = document.createElement('div');
        
        if (isMatched) {
            el.className = 'bg-green-100 dark:bg-green-900/30 border-2 border-green-500 dark:border-green-600 text-green-700 dark:text-green-300 rounded-2xl p-2 md:p-3 flex items-center justify-center text-center h-full font-bold anim-correct text-xs md:text-sm shadow-inner';
        } else {
            el.className = 'bg-white dark:bg-dark-card border-2 border-slate-200 dark:border-slate-700 rounded-2xl p-2 md:p-3 flex items-center justify-center text-center cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-600 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all select-none h-full font-medium text-slate-700 dark:text-slate-200 active:scale-95 text-xs md:text-sm btn-press shadow-sm break-words';
            el.onclick = () => handleMatchClick(card.id, card.refId, el);
        }
        
        el.textContent = card.content;
        grid.appendChild(el);
    });
}
function handleMatchClick(id, refId, el) { 
    if (matchMatched.includes(id) || matchSelected.some(s => s.id === id) || matchSelected.length >= 2) return; 
    el.classList.add('border-indigo-500', 'bg-indigo-50', 'dark:bg-indigo-900/40', 'dark:border-indigo-500'); 
    matchSelected.push({ id, refId, el }); 
    if (matchSelected.length === 2) setTimeout(checkMatch, 300); 
}

function checkMatch() {
    const [c1, c2] = matchSelected;
    if (c1.refId === c2.refId) {
        // Correct match
        [c1.el, c2.el].forEach(el => el.className = 'bg-green-100 dark:bg-green-900/30 border-2 border-green-500 dark:border-green-600 text-green-700 dark:text-green-300 rounded-2xl p-2 md:p-3 flex items-center justify-center text-center h-full font-bold anim-correct text-xs md:text-sm shadow-inner');
        matchMatched.push(c1.id, c2.id);
        matchCorrectPairs++;
        
        // Track word as learned
        trackWordLearned(c1.refId);
        
        // Check if current batch is complete (all 10 pairs matched)
        const BATCH_SIZE = 10;
        const currentBatchPairs = Math.floor(matchMatched.length / 2);
        const pairsInCurrentBatch = currentBatchPairs - (matchCurrentBatch * BATCH_SIZE);
        
        if (pairsInCurrentBatch >= BATCH_SIZE && matchMatched.length < matchCards.length) {
            // Move to next batch
            matchCurrentBatch++;
            setTimeout(() => renderMatchingBatch(), 500);
        }
        
        // Check if all pairs are matched
        if (matchMatched.length === matchCards.length) {
            stopMatchTimer();
            setTimeout(() => finishMatching(), 1000);
        }
    } else {
        // Wrong match
        matchWrongAttempts++;
        [c1.el, c2.el].forEach(el => el.classList.add('anim-wrong'));
        setTimeout(() => {
            [c1.el, c2.el].forEach(el => el.className = 'bg-white dark:bg-dark-card border-2 border-slate-200 dark:border-slate-700 rounded-2xl p-2 md:p-3 flex items-center justify-center text-center cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-600 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all select-none h-full font-medium text-slate-700 dark:text-slate-200 active:scale-95 text-xs md:text-sm btn-press shadow-sm break-words');
        }, 600);
    }
    matchSelected = [];
}

function finishMatching() {
    // Calculate accuracy
    const totalAttempts = matchCorrectPairs + matchWrongAttempts;
    const accuracy = totalAttempts > 0 ? Math.round((matchCorrectPairs / totalAttempts) * 100) : 0;
    
    // Update stats
    if (!userStats.matchingStats) userStats.matchingStats = { total: 0, correct: 0 };
    userStats.matchingStats.total += totalAttempts;
    userStats.matchingStats.correct += matchCorrectPairs;
    saveStats();
    
    // Show result with accuracy
    showMatchingResult(`Hoàn thành trong ${formatTime(matchTime)}!`, accuracy, matchCorrectPairs, matchTotalPairs);
}
function startMatchTimer() { const timerEl = document.getElementById('match-timer'); matchTimerInterval = setInterval(() => { matchTime++; if(timerEl) timerEl.textContent = formatTime(matchTime); }, 1000); }
function stopMatchTimer() { clearInterval(matchTimerInterval); }
function formatTime(s) { return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`; }
// Helper to show result from match
function showMatchingResult(msg, accuracy, correct, total) {
    showView('result');
    document.getElementById('result-message').textContent = msg;
    
    // Show accuracy stats
    const statsBlock = document.getElementById('result-stats-block');
    if (statsBlock) {
        statsBlock.style.display = 'grid';
        statsBlock.innerHTML = `
            <div class="bg-green-50 dark:bg-green-900/20 p-3 rounded-2xl border border-green-100 dark:border-green-900/30">
                <div class="text-2xl font-bold text-green-600 dark:text-green-400">${correct}/${total}</div>
                <div class="text-[10px] text-green-800 dark:text-green-300 uppercase font-bold tracking-wider">Cặp đúng</div>
            </div>
            <div class="bg-indigo-50 dark:bg-indigo-900/20 p-3 rounded-2xl border border-indigo-100 dark:border-indigo-900/30">
                <div class="text-2xl font-bold text-indigo-600 dark:text-indigo-400">${accuracy}%</div>
                <div class="text-[10px] text-indigo-800 dark:text-indigo-300 uppercase font-bold tracking-wider">Tỉ lệ chính xác</div>
            </div>
        `;
    }
    
    document.getElementById('btn-relearn').classList.add('hidden');
    updateRepeatButton();
}

// Init App
async function initApp() {
    initTheme();
    await loadVocabSets();
    showView('home');
}

initApp();

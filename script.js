const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { ipcRenderer } = require('electron');
const characterExtractionCLI = require('./characterExtractionCLI');

// Helper function to get the characters file path in the audiobook folder
function getCharactersFilePath(book) {
    return path.join(audiobooksDir, book, 'characters.json');
}

const bookList = document.getElementById('book-list');
const player = document.getElementById('player');
const title = document.getElementById('title');
const currentChapter = document.getElementById('current-chapter');
const audio = document.getElementById('audio');
const playlist = document.getElementById('playlist');
const captionsDisplay = document.getElementById('captions-display'); // New element for captions


const chapterSettingsModal = document.getElementById('chapter-settings-modal');
const chapterSettingsCloseButton = document.getElementById('chapter-settings-close-button');
const renameChapterInput = document.getElementById('rename-chapter-input');
const chapterOrderSelect = document.getElementById('chapter-order-select');
const saveChapterSettingsButton = document.getElementById('save-chapter-settings-button');
const cancelChapterSettingsButton = document.getElementById('cancel-chapter-settings-button');
const refreshChaptersBtn = document.getElementById('refresh-chapters-btn');

let activeBookForSettings = null;
let activeChapterIndexForSettings = null;
let bookChaptersForSettings = [];
let currentCharacters = [];



// Add refresh chapters functionality
refreshChaptersBtn.addEventListener('click', () => {
    // Delete all chapters.json files
    const books = fs.readdirSync(audiobooksDir, { withFileTypes: true })
        .filter(file => file.isDirectory() && file.name !== 'character_extraction_instructions' && !file.name.startsWith('.'))
        .map(dir => dir.name);
    
    books.forEach(book => {
        const chaptersJsonPath = path.join(audiobooksDir, book, 'chapters.json');
        if (fs.existsSync(chaptersJsonPath)) {
            fs.unlinkSync(chaptersJsonPath);
        }
    });
    
    // Reload the books
    loadBooks();
    alert('Chapter lists have been refreshed from MP3 files!');
});

function openChapterSettingsModal(book, chapterIndex, chapters) {
    activeBookForSettings = book;
    activeChapterIndexForSettings = chapterIndex;
    bookChaptersForSettings = [...chapters]; // Create a copy to modify

    const chapter = bookChaptersForSettings[chapterIndex];
    renameChapterInput.value = chapter.title;

    chapterOrderSelect.innerHTML = '';
    for (let i = 0; i < chapters.length; i++) {
        const option = document.createElement('option');
        option.value = i;
        option.textContent = `Chapter ${i + 1}`;
        if (i === chapterIndex) {
            option.selected = true;
        }
        chapterOrderSelect.appendChild(option);
    }

    chapterSettingsModal.style.display = 'block';
}

function closeChapterSettingsModal() {
    chapterSettingsModal.style.display = 'none';
}

chapterSettingsCloseButton.addEventListener('click', closeChapterSettingsModal);
cancelChapterSettingsButton.addEventListener('click', closeChapterSettingsModal);

saveChapterSettingsButton.addEventListener('click', () => {
    const newTitle = renameChapterInput.value;
    const oldChapter = chapters[activeChapterIndexForSettings];
    const oldTitle = oldChapter.title;
    const newIndex = parseInt(chapterOrderSelect.value);

    // Reorder chapters
    const chapterToMove = bookChaptersForSettings.splice(activeChapterIndexForSettings, 1)[0];
    bookChaptersForSettings.splice(newIndex, 0, chapterToMove);

    // Rename files if title changed
    if (newTitle !== oldTitle) {
        const bookDir = path.join(audiobooksDir, activeBookForSettings);
        const oldAudioPath = path.join(bookDir, `${oldTitle}.mp3`);
        const newAudioPath = path.join(bookDir, `${newTitle}.mp3`);
        const oldTxtPath = path.join(bookDir, `${oldTitle}.txt`);
        const newTxtPath = path.join(bookDir, `${newTitle}.txt`);
        const oldSegmentsPath = path.join(bookDir, `${oldTitle}.segments.json`);
        const newSegmentsPath = path.join(bookDir, `${newTitle}.segments.json`);

        if (fs.existsSync(oldAudioPath)) fs.renameSync(oldAudioPath, newAudioPath);
        if (fs.existsSync(oldTxtPath)) fs.renameSync(oldTxtPath, newTxtPath);
        if (fs.existsSync(oldSegmentsPath)) fs.renameSync(oldSegmentsPath, newSegmentsPath);
    }


    // Update the chapter data
    bookChaptersForSettings[newIndex].title = newTitle;
    const newFilePath = path.join(audiobooksDir, activeBookForSettings, `${newTitle}.mp3`);
    bookChaptersForSettings[newIndex].audio = `file:///${newFilePath.replace(/\\/g, '/')}`;


    const bookDir = path.join(audiobooksDir, activeBookForSettings);
    saveChaptersMetadata(bookDir, bookChaptersForSettings);

    // Re-render the chapters for the active book
    const bookContainer = Array.from(bookList.querySelectorAll('.book-item')).find(item => item.textContent === activeBookForSettings).parentElement;
    const chapterListContainer = bookContainer.querySelector('.chapter-list-container');
    renderBookChaptersInBrowser(activeBookForSettings, chapterListContainer);

    closeChapterSettingsModal();
});


let chapters = [];
let currentChapterIndex = 0;
let currentBook = '';
let currentSegments = []; // Store segments for the current chapter
let isLoadingChapters = false; // Prevent multiple simultaneous loads

// Selection tracking for batch operations
let selectedChapters = new Set();
let currentSelectionMode = null; // 'transcribe' or 'character'

const audiobooksDir = path.join(__dirname, 'audiobooks');


// Initialize Whisper client
const whisperClient = new WhisperClient();

async function transcribeAudio(book, chapter, container, chapterElement, actionButton) {
    const bookDir = path.join(audiobooksDir, book);
    const chapterFilePath = path.join(bookDir, `${chapter.title}.mp3`);
    const transcriptionFilePath = path.join(bookDir, `${chapter.title}.txt`);
    const segmentsFilePath = path.join(bookDir, `${chapter.title}.segments.json`);

    // Check if audio file exists
    if (!fs.existsSync(chapterFilePath)) {
        // Try to find a similar file
        if (fs.existsSync(bookDir)) {
            const files = fs.readdirSync(bookDir);
            const mp3Files = files.filter(f => f.endsWith('.mp3') || f.endsWith('.MP3'));
            
            // Check for case-insensitive match
            const matchingFile = mp3Files.find(f => 
                f.toLowerCase() === `${chapter.title}.mp3`.toLowerCase()
            );
            
            if (matchingFile) {
                alert(`File name case mismatch. Expected: "${chapter.title}.mp3", Found: "${matchingFile}"`);
            } else {
                alert(`Audio file not found: ${chapter.title}.mp3\n\nAvailable files:\n${mp3Files.join('\n')}`);
            }
        }
        return;
    }

    // Check if transcription already exists
    if (fs.existsSync(transcriptionFilePath) && fs.existsSync(segmentsFilePath)) {
        return;
    }
    
    // Add visual indicators
    if (chapterElement) {
        chapterElement.classList.add('transcribing');
    }
    if (actionButton) {
        actionButton.classList.add('processing');
        actionButton.setAttribute('data-original-text', actionButton.textContent);
    }

    // Function to remove visual indicators
    const removeIndicators = () => {
        if (chapterElement) {
            chapterElement.classList.remove('transcribing');
        }
        if (actionButton) {
            actionButton.classList.remove('processing');
            const originalText = actionButton.getAttribute('data-original-text');
            if (originalText) {
                actionButton.textContent = originalText;
            }
        }
    };

    // Try to use Whisper service first
    try {
        const result = await whisperClient.transcribe(chapterFilePath);
        
        if (result.success) {
            // Save transcription to files
            fs.writeFileSync(transcriptionFilePath, result.transcription, 'utf-8');
            fs.writeFileSync(segmentsFilePath, JSON.stringify(result.segments, null, 2), 'utf-8');
            
            // Remove visual indicators
            removeIndicators();
            
            // Refresh the chapter display to show transcription is complete
            if (container) {
                renderBookChaptersInBrowser(book, container);
            }
            
            return;
        }
    } catch (error) {
        console.error('Whisper service error:', error.message);
        
        // Remove visual indicators
        removeIndicators();
        
        // Service not available - show message
        alert('Whisper service is not running. Please click the AI Services button to set up the service.');
        return;
    }
}

async function loadStoryboardsForChapter(book, chapterTitle) {
    // Extract just the chapter number from the full title
    const chapterMatch = chapterTitle.match(/Chapter (\d+)/i);
    const simpleChapterName = chapterMatch ? `Chapter ${chapterMatch[1]}` : chapterTitle;
    
    const storyboardPath = path.join(audiobooksDir, book, 'storyboards', `${simpleChapterName}.json`);
    
    console.log('Checking for storyboard at:', storyboardPath);
    
    if (fs.existsSync(storyboardPath)) {
        try {
            const storyboardData = JSON.parse(fs.readFileSync(storyboardPath, 'utf-8'));
            console.log('Loaded storyboard data:', storyboardData);
            
            // Handle template format with instructions
            if (storyboardData.data && Array.isArray(storyboardData.data)) {
                return storyboardData.data[0].scenes || [];
            }
            // Handle array format (current working format)
            if (Array.isArray(storyboardData) && storyboardData.length > 0 && storyboardData[0].scenes) {
                return storyboardData[0].scenes;
            }
            // Handle old direct format
            return storyboardData.scenes || [];
        } catch (e) {
            console.error('Error loading storyboard:', e);
            return [];
        }
    }
    
    console.log('No storyboard file found');
    return [];
}

let currentStoryboards = [];
let currentStoryboardIndex = -1;

async function renderPlaylist() {
    playlist.innerHTML = '';
    
    // Check if current chapter has storyboards
    if (currentChapterIndex >= 0 && currentChapterIndex < chapters.length) {
        const currentChapterTitle = chapters[currentChapterIndex].title;
        currentStoryboards = await loadStoryboardsForChapter(currentBook, currentChapterTitle);
        
        console.log(`Loaded ${currentStoryboards.length} storyboards for ${currentChapterTitle}`);
        
        if (currentStoryboards.length > 0) {
            // Render storyboards
            renderStoryboardList();
            return;
        }
    }
    
    // Default: render chapter list
    chapters.forEach((chapter, index) => {
        const item = document.createElement('div');
        item.classList.add('playlist-item');
        if (index === currentChapterIndex) {
            item.classList.add('active');
        }
        item.textContent = chapter.title;
        item.addEventListener('click', () => {
            playChapter(index);
        });
        playlist.appendChild(item);
    });
}

function renderStoryboardList() {
    playlist.innerHTML = '';
    
    // Add header
    const header = document.createElement('div');
    header.classList.add('storyboard-header');
    header.innerHTML = `<h3>Storyboards - ${chapters[currentChapterIndex].title}</h3>`;
    playlist.appendChild(header);
    
    // Add storyboards
    currentStoryboards.forEach((scene, index) => {
        const item = document.createElement('div');
        item.classList.add('storyboard-item');
        
        // Time range
        const timeRange = document.createElement('div');
        timeRange.classList.add('storyboard-time');
        timeRange.textContent = `${formatTime(scene.startTime)} - ${formatTime(scene.endTime)}`;
        
        // Scene parameters or description (backwards compatible)
        const description = document.createElement('div');
        description.classList.add('storyboard-description');
        
        if (scene.parameters) {
            // New parameter-based format
            const params = scene.parameters;
            description.innerHTML = `
                <div class="scene-params">
                    <div><strong>Camera:</strong> ${params.camera}</div>
                    <div><strong>Environment:</strong> ${params.environment}</div>
                    <div><strong>Mood:</strong> ${params.mood}</div>
                    ${params.foreground ? `<div><strong>Foreground:</strong> ${params.foreground}</div>` : ''}
                    ${params.background ? `<div><strong>Background:</strong> ${params.background}</div>` : ''}
                </div>
            `;
        } else if (scene.description) {
            // Old description format (backwards compatible)
            description.textContent = scene.description;
        }
        
        // Characters - move this after description
        const charactersDiv = document.createElement('div');
        const characters = scene.parameters?.characters || scene.characters;
        if (characters && characters.length > 0) {
            charactersDiv.classList.add('storyboard-characters');
            let charHtml = `<span class="char-label">Characters:</span> ${characters.join(', ')}`;
            
            // Add character poses if available
            if (scene.parameters?.characterPoses) {
                const poses = scene.parameters.characterPoses;
                if (characters[0] && poses.character1) {
                    charHtml += `<div class="char-pose"><strong>${characters[0]}:</strong> ${poses.character1}</div>`;
                }
                if (characters[1] && poses.character2) {
                    charHtml += `<div class="char-pose"><strong>${characters[1]}:</strong> ${poses.character2}</div>`;
                }
            }
            
            charactersDiv.innerHTML = charHtml;
        }
        
        // Scene image placeholder
        const imageContainer = document.createElement('div');
        imageContainer.classList.add('storyboard-image-container');
        
        if (scene.imageGenerated && scene.imagePath) {
            const img = document.createElement('img');
            img.src = path.join(audiobooksDir, currentBook, scene.imagePath);
            img.classList.add('storyboard-image');
            imageContainer.appendChild(img);
        } else {
            const placeholder = document.createElement('div');
            placeholder.classList.add('storyboard-placeholder');
            placeholder.innerHTML = `
                <span>🎬</span>
                <button class="generate-scene-btn" data-scene-index="${index}">Generate Image</button>
            `;
            imageContainer.appendChild(placeholder);
        }
        
        item.appendChild(timeRange);
        item.appendChild(description);
        if (characters && characters.length > 0) {
            item.appendChild(charactersDiv);
        }
        item.appendChild(imageContainer);
        
        // Highlight active storyboard based on current audio time
        if (audio.currentTime >= scene.startTime && audio.currentTime < scene.endTime) {
            item.classList.add('active');
            currentStoryboardIndex = index;
        }
        
        // Click to jump to scene
        item.addEventListener('click', () => {
            audio.currentTime = scene.startTime;
            currentStoryboardIndex = index;
            renderStoryboardList();
        });
        
        playlist.appendChild(item);
    });
    
    // Add event listeners for generate buttons
    document.querySelectorAll('.generate-scene-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const sceneIndex = parseInt(e.target.dataset.sceneIndex);
            await generateSceneImage(currentStoryboards[sceneIndex], sceneIndex);
        });
    });
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

async function playChapter(index) {
    currentChapterIndex = index;
    const chapter = chapters[index];
    title.textContent = currentBook;
    currentChapter.textContent = chapter.title;
    
    // Stop any current playback before changing source
    audio.pause();
    audio.currentTime = 0;
    
    audio.src = chapter.audio;
    
    // Only play if not already loading
    if (audio.readyState >= 2) { // HAVE_CURRENT_DATA or better
        audio.play().catch(() => {
            // Silently ignore play errors
        });
    } else {
        // Wait for audio to be ready before playing
        audio.addEventListener('canplay', function onCanPlay() {
            audio.removeEventListener('canplay', onCanPlay);
            audio.play().catch(() => {
                // Silently ignore play errors
            });
        });
    }
    
    await renderPlaylist();
    loadAndDisplayCaptions(chapter);
    loadCharacters(currentBook);
}

audio.addEventListener('ended', () => {
    if (currentChapterIndex < chapters.length - 1) {
        playChapter(currentChapterIndex + 1);
    }
});

audio.addEventListener('timeupdate', () => {
    const currentTime = audio.currentTime;
    
    // Update captions
    if (currentSegments.length > 0) {
        let activeSegment = null;
        for (let i = 0; i < currentSegments.length; i++) {
            if (currentTime >= currentSegments[i].start && currentTime <= currentSegments[i].end) {
                activeSegment = currentSegments[i];
                break;
            }
        }
        if (activeSegment) {
            captionsDisplay.textContent = activeSegment.text;
        } else {
            captionsDisplay.textContent = '';
        }
    }
    
    // Update active storyboard
    if (currentStoryboards.length > 0) {
        let newStoryboardIndex = -1;
        for (let i = 0; i < currentStoryboards.length; i++) {
            if (currentTime >= currentStoryboards[i].startTime && currentTime < currentStoryboards[i].endTime) {
                newStoryboardIndex = i;
                break;
            }
        }
        
        if (newStoryboardIndex !== currentStoryboardIndex) {
            currentStoryboardIndex = newStoryboardIndex;
            // Update active state in UI
            document.querySelectorAll('.storyboard-item').forEach((item, index) => {
                if (index === currentStoryboardIndex) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });
        }
    }
});

async function loadAndDisplayCaptions(chapter) {
    const segmentsFilePath = path.join(audiobooksDir, currentBook, `${chapter.title}.segments.json`);
    if (fs.existsSync(segmentsFilePath)) {
        currentSegments = JSON.parse(fs.readFileSync(segmentsFilePath, 'utf-8'));
        captionsDisplay.textContent = ''; // Clear previous captions
    } else {
        currentSegments = [];
        captionsDisplay.textContent = 'No captions available. Transcribe the chapter to generate them.';
    }
}

async function handleActionClick(action, book, chapter, container, chapterElement) {
    const chapterKey = `${book}|${chapter.title}`;
    const actionButton = chapterElement.querySelector(`.${action}-btn`);
    
    // If no selection mode is set, set it to the current action
    if (!currentSelectionMode) {
        currentSelectionMode = action;
        showSelectionControls();
        // Show a brief notification that batch mode is active
        showBatchModeNotification(action);
    }
    
    // If trying to mix actions, show warning
    if (currentSelectionMode !== action) {
        alert(`You are currently in ${currentSelectionMode} mode. Please complete or cancel the current operation before switching.`);
        return;
    }
    
    // Toggle selection
    if (selectedChapters.has(chapterKey)) {
        selectedChapters.delete(chapterKey);
        actionButton.classList.remove('selected');
    } else {
        selectedChapters.add(chapterKey);
        actionButton.classList.add('selected');
    }
    
    // If no chapters selected, hide controls
    if (selectedChapters.size === 0) {
        hideSelectionControls();
        currentSelectionMode = null;
    } else {
        updateSelectionControls();
    }
}

function showSelectionControls() {
    // Check if controls already exist
    let controlsDiv = document.getElementById('batch-controls');
    if (controlsDiv) return;
    
    controlsDiv = document.createElement('div');
    controlsDiv.id = 'batch-controls';
    controlsDiv.classList.add('batch-controls');
    
    const modeLabel = document.createElement('span');
    let modeText = '';
    switch(currentSelectionMode) {
        case 'transcribe':
            modeText = 'Transcribe';
            break;
        case 'character':
            modeText = 'Extract Characters';
            break;
        case 'storyboard':
            modeText = 'Generate Storyboards';
            break;
    }
    modeLabel.textContent = `${modeText} Mode`;
    modeLabel.classList.add('mode-label');
    
    const processBtn = document.createElement('button');
    processBtn.textContent = `Process ${selectedChapters.size} Chapter(s)`;
    processBtn.classList.add('process-btn');
    processBtn.addEventListener('click', processBatchAction);
    
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.classList.add('cancel-btn');
    cancelBtn.addEventListener('click', cancelBatchSelection);
    
    controlsDiv.appendChild(modeLabel);
    controlsDiv.appendChild(processBtn);
    controlsDiv.appendChild(cancelBtn);
    
    const bookList = document.getElementById('book-list');
    bookList.insertBefore(controlsDiv, bookList.firstChild);
}

function hideSelectionControls() {
    const controlsDiv = document.getElementById('batch-controls');
    if (controlsDiv) {
        controlsDiv.remove();
    }
}

function updateSelectionControls() {
    const processBtn = document.querySelector('#batch-controls .process-btn');
    if (processBtn) {
        processBtn.textContent = `Process ${selectedChapters.size} Chapter(s)`;
    }
}

function showBatchModeNotification(action) {
    const notification = document.createElement('div');
    notification.className = 'batch-mode-notification';
    let actionText = '';
    switch(action) {
        case 'transcribe':
            actionText = 'Transcribe';
            break;
        case 'character':
            actionText = 'Character Extraction';
            break;
        case 'storyboard':
            actionText = 'Storyboard Generation';
            break;
    }
    notification.textContent = `Batch ${actionText} mode activated. Click chapters to select them.`;
    
    document.body.appendChild(notification);
    
    // Animate in
    setTimeout(() => notification.classList.add('show'), 10);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

async function processBatchAction() {
    if (selectedChapters.size === 0) return;
    
    // Check AI Terminal connection for character extraction mode
    if (currentSelectionMode === 'character') {
        if (!globalAITerminal || !globalAITerminal.isConnected || !globalAITerminal.currentTool) {
            alert('Character extraction requires an AI assistant to be selected.\n\nPlease select either Claude Code or Gemini CLI in the AI Terminal before batch processing.');
            return;
        }
    }
    
    const chaptersToProcess = Array.from(selectedChapters);
    
    if (currentSelectionMode === 'transcribe') {
        // Process transcriptions one by one
        const progressDiv = createProgressIndicator(chaptersToProcess.length);
        
        for (let i = 0; i < chaptersToProcess.length; i++) {
            const [book, chapterTitle] = chaptersToProcess[i].split('|');
            const chapter = { title: chapterTitle };
            
            updateProgressIndicator(progressDiv, i + 1, chaptersToProcess.length, `Processing: ${chapterTitle}`);
            await transcribeAudio(book, chapter, null, null, null);
        }
        
        removeProgressIndicator(progressDiv);
    } else if (currentSelectionMode === 'character') {
        // Group chapters by book for batch processing
        const chaptersByBook = new Map();
        
        chaptersToProcess.forEach(chapterKey => {
            const [book, chapterTitle] = chapterKey.split('|');
            if (!chaptersByBook.has(book)) {
                chaptersByBook.set(book, []);
            }
            chaptersByBook.get(book).push(chapterTitle);
        });
        
        // Process each book's chapters as a batch
        for (const [book, chapters] of chaptersByBook) {
            await extractCharactersBatch(book, chapters);
        }
    } else if (currentSelectionMode === 'storyboard') {
        // Check AI Terminal connection for storyboard generation
        if (!globalAITerminal || !globalAITerminal.isConnected || !globalAITerminal.currentTool) {
            alert('Storyboard generation requires an AI assistant to be selected.\n\nPlease select either Claude Code or Gemini CLI in the AI Terminal before batch processing.');
            return;
        }
        
        // Group chapters by book for batch processing
        const chaptersByBook = new Map();
        
        chaptersToProcess.forEach(chapterKey => {
            const [book, chapterTitle] = chapterKey.split('|');
            if (!chaptersByBook.has(book)) {
                chaptersByBook.set(book, []);
            }
            chaptersByBook.get(book).push(chapterTitle);
        });
        
        // Process each book's chapters as a batch
        for (const [book, chapters] of chaptersByBook) {
            await generateStoryboardsBatch(book, chapters);
        }
    }
    
    cancelBatchSelection();
    
    // Refresh the book list to show updated states
    loadBooks();
}

function cancelBatchSelection() {
    // Remove selected class from all action buttons
    document.querySelectorAll('.action-symbol-btn.selected').forEach(button => {
        button.classList.remove('selected');
    });
    
    selectedChapters.clear();
    currentSelectionMode = null;
    hideSelectionControls();
}

function createProgressIndicator(total) {
    const progressDiv = document.createElement('div');
    progressDiv.classList.add('batch-progress');
    progressDiv.innerHTML = `
        <div class="progress-bar">
            <div class="progress-fill" style="width: 0%"></div>
        </div>
        <div class="progress-text">Processing 0 of ${total}</div>
    `;
    
    const controlsDiv = document.getElementById('batch-controls');
    controlsDiv.appendChild(progressDiv);
    
    return progressDiv;
}

function updateProgressIndicator(progressDiv, current, total, message) {
    const fill = progressDiv.querySelector('.progress-fill');
    const text = progressDiv.querySelector('.progress-text');
    
    const percentage = (current / total) * 100;
    fill.style.width = `${percentage}%`;
    text.textContent = `${message} (${current} of ${total})`;
}

function removeProgressIndicator(progressDiv) {
    if (progressDiv && progressDiv.parentNode) {
        progressDiv.remove();
    }
}

async function extractCharacters(book, chapter, showAlerts = true) {
    const bookDir = path.join(audiobooksDir, book);
    const transcriptionFilePath = path.join(bookDir, `${chapter.title}.txt`);
    const globalCharsPath = getCharactersFilePath(book);
    
    if (!fs.existsSync(transcriptionFilePath)) {
        console.log(`Skipping character extraction for ${chapter.title} - no transcription found`);
        if (showAlerts) {
            alert(`Please transcribe chapter "${chapter.title}" first before extracting characters.`);
        }
        return false;
    }
    
    const transcript = fs.readFileSync(transcriptionFilePath, 'utf-8');
    
    let globalCharacters = [];
    try {
        if (fs.existsSync(globalCharsPath)) {
            const fileContent = fs.readFileSync(globalCharsPath, 'utf-8');
            if (fileContent) {
                globalCharacters = JSON.parse(fileContent);
            }
        }
    } catch (e) {
        console.error(`Error reading characters.json for book "${book}":`, e);
        if (showAlerts) {
            alert(`Error reading character data for book "${book}"`);
        }
        return false;
    }
    
    // Find chapter index
    const chaptersJsonPath = path.join(bookDir, 'chapters.json');
    let chapterIndex = -1;
    if (fs.existsSync(chaptersJsonPath)) {
        const chapters = JSON.parse(fs.readFileSync(chaptersJsonPath, 'utf-8'));
        chapterIndex = chapters.findIndex(c => c.title === chapter.title);
    }
    
    if (chapterIndex === -1) {
        console.error(`Could not find chapter index for ${chapter.title}`);
        if (showAlerts) {
            alert(`Error: Could not find chapter "${chapter.title}" in book structure.`);
        }
        return false;
    }
    
    // Check if chapter already has characters extracted
    const isChapterProcessed = globalCharacters.some(c => c.chapters && c.chapters.includes(chapterIndex + 1));
    if (isChapterProcessed) {
        console.log(`Chapter ${chapter.title} already has characters extracted`);
        if (showAlerts) {
            alert(`Characters have already been extracted for chapter "${chapter.title}".`);
        }
        return false;
    }
    
    // Check if AI Terminal is available and use CLI mode
    if (!globalAITerminal || !globalAITerminal.isConnected || !globalAITerminal.currentTool) {
        console.error('AI Terminal not connected or no tool selected');
        if (showAlerts) {
            alert('Character extraction requires an AI assistant to be selected.\n\nPlease select either Claude Code or Gemini CLI in the AI Terminal.');
        }
        return false;
    }
    
    // Use CLI-based character extraction
    return await extractCharactersViaCLI(book, chapter, transcript, globalCharacters, chapterIndex + 1, showAlerts);
}

// New function to handle CLI-based character extraction
async function extractCharactersViaCLI(book, chapter, transcript, existingCharacters, chapterNumber, showAlerts) {
    try {
        const bookPath = path.join(audiobooksDir, book);
        
        // Get the prompt file from the backend
        const result = await ipcRenderer.invoke('get-main-characters-cli', {
            transcript,
            existingCharacters: JSON.stringify(existingCharacters),
            chapterNumber: chapterNumber,
            bookPath: bookPath,
            contextInfo: currentStoryContext
        });
        
        if (result.error) {
            console.error(`Error preparing character extraction: ${result.error}`);
            if (showAlerts) {
                alert(`Error preparing character extraction: ${result.error}`);
            }
            return false;
        }
        
        const { promptFile } = result;
        
        // Convert Windows path to WSL path
        const isWindows = process.platform === 'win32';
        let wslPromptFile = promptFile;
        
        if (isWindows) {
            // Convert C:\Users\... to /mnt/c/Users/...
            wslPromptFile = promptFile.replace(/^([A-Z]):\\/, (match, drive) => `/mnt/${drive.toLowerCase()}/`);
            wslPromptFile = wslPromptFile.replace(/\\/g, '/');
        }
        
        // Save the characters.json directly in the audiobook folder
        const localOutputFile = path.join(bookPath, 'characters.json');
        
        let wslOutputFile = localOutputFile;
        if (isWindows) {
            // Convert Windows path to WSL path
            wslOutputFile = localOutputFile.replace(/^([A-Z]):\\/, (match, drive) => `/mnt/${drive.toLowerCase()}/`);
            wslOutputFile = wslOutputFile.replace(/\\/g, '/');
        }
        
        // Use the module to build the CLI command
        const { command, commandOptions } = characterExtractionCLI.buildCLICommand(
            globalAITerminal.currentTool,
            wslPromptFile,
            wslOutputFile
        );
        
        // Show progress in terminal
        globalAITerminal.terminal.writeln(`\n\x1b[33mExtracting characters from ${chapter.title}...\x1b[0m`);
        globalAITerminal.terminal.writeln(`\x1b[90mUsing ${globalAITerminal.currentTool === 'claude' ? 'Claude Code' : 'Gemini CLI'}\x1b[0m`);
        
        // Send the command
        const success = globalAITerminal.sendCommand(command, commandOptions);
        
        if (!success) {
            throw new Error('Failed to send command to AI terminal');
        }
        
        // Show status message
        if (showAlerts) {
            const statusDiv = document.createElement('div');
            statusDiv.className = 'extraction-status';
            statusDiv.innerHTML = `
                <div style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); 
                     background: #2a2a2a; color: white; padding: 20px; border-radius: 8px; 
                     box-shadow: 0 4px 12px rgba(0,0,0,0.5); z-index: 10000;">
                    <h3 style="margin: 0 0 10px 0;">Extracting Characters</h3>
                    <p style="margin: 0;">Processing ${chapter.title} with ${globalAITerminal.currentTool === 'claude' ? 'Claude Code' : 'Gemini CLI'}...</p>
                    <div style="margin-top: 10px; font-size: 12px; color: #aaa;">This may take a moment...</div>
                </div>
            `;
            document.body.appendChild(statusDiv);
            
            // Remove status after completion
            setTimeout(() => statusDiv.remove(), 8000);
        }
        
        // Wait for command completion with a longer timeout for character extraction
        await new Promise(resolve => setTimeout(resolve, 8000));
        
        // Check if the file was created in the audiobook directory
        let extractionSuccess = false;
        
        if (fs.existsSync(localOutputFile)) {
            // Use the module to validate the output
            try {
                const validation = await characterExtractionCLI.validateCharacterOutput(localOutputFile);
                
                if (validation.success) {
                    globalAITerminal.terminal.writeln(`\x1b[32m✓ Character extraction completed successfully!\x1b[0m`);
                    globalAITerminal.terminal.writeln(`\x1b[90mFound ${validation.count} characters\x1b[0m`);
                    extractionSuccess = true;
                } else {
                    console.error('Invalid character output:', validation.error);
                    globalAITerminal.terminal.writeln(`\x1b[31m✗ Character extraction error: ${validation.error}\x1b[0m`);
                    if (showAlerts) {
                        alert(`Character extraction error: ${validation.error}`);
                    }
                }
            } catch (e) {
                console.error('Error validating output file:', e);
                globalAITerminal.terminal.writeln(`\x1b[31m✗ Error processing output file: ${e.message}\x1b[0m`);
            }
        } else {
            globalAITerminal.terminal.writeln(`\x1b[31m✗ Character extraction failed - no output file created\x1b[0m`);
            globalAITerminal.terminal.writeln(`\x1b[90mPlease check the terminal output for errors\x1b[0m`);
        }
        
        // Clean up the prompt file
        // TODO: Re-enable cleanup after ensuring Claude has finished reading the file
        // For now, commenting out to debug file access issues
        /*
        try {
            if (fs.existsSync(promptFile)) {
                fs.unlinkSync(promptFile);
            }
        } catch (e) {
            console.error('Failed to clean up prompt file:', e);
        }
        */
        
        return extractionSuccess;
        
    } catch (error) {
        console.error(`Error in CLI character extraction for ${chapter.title}:`, error);
        if (showAlerts) {
            alert(`Error extracting characters via CLI: ${error.message}`);
        }
        return false;
    }
}

// Batch character extraction via CLI
async function extractCharactersBatch(book, chaptersToProcess) {
    try {
        const bookPath = path.join(audiobooksDir, book);
        const globalCharsPath = getCharactersFilePath(book);
        
        // Load existing characters
        let globalCharacters = [];
        try {
            if (fs.existsSync(globalCharsPath)) {
                const fileContent = fs.readFileSync(globalCharsPath, 'utf-8');
                if (fileContent) {
                    globalCharacters = JSON.parse(fileContent);
                    
                    // Warn if character data is getting very large
                    const sizeInMB = fileContent.length / (1024 * 1024);
                    if (sizeInMB > 5) {
                        console.warn(`Warning: characters.json is ${sizeInMB.toFixed(2)} MB. Consider processing fewer chapters at once.`);
                    }
                }
            }
        } catch (e) {
            console.error(`Error reading characters.json for book "${book}":`, e);
            return false;
        }
        
        // Load chapters.json to get chapter indices
        const chaptersJsonPath = path.join(bookPath, 'chapters.json');
        let allChapters = [];
        if (fs.existsSync(chaptersJsonPath)) {
            allChapters = JSON.parse(fs.readFileSync(chaptersJsonPath, 'utf-8'));
        }
        
        // Prepare chapter data with transcripts
        const chaptersData = [];
        for (const chapterTitle of chaptersToProcess) {
            const chapterIndex = allChapters.findIndex(c => c.title === chapterTitle);
            if (chapterIndex === -1) continue;
            
            const transcriptPath = path.join(bookPath, `${chapterTitle}.txt`);
            if (!fs.existsSync(transcriptPath)) {
                console.log(`Skipping ${chapterTitle} - no transcript found`);
                continue;
            }
            
            const transcript = fs.readFileSync(transcriptPath, 'utf-8');
            chaptersData.push({
                title: chapterTitle,
                number: chapterIndex + 1,
                transcript: transcript
            });
        }
        
        if (chaptersData.length === 0) {
            alert('No transcripts found for the selected chapters.');
            return false;
        }
        
        // Add a small delay to let the UI breathe before heavy IPC operation
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Get the prompt file from the backend
        const result = await ipcRenderer.invoke('get-main-characters-batch-cli', {
            chapters: chaptersData,
            existingCharacters: JSON.stringify(globalCharacters),
            bookPath: bookPath,
            contextInfo: currentStoryContext
        });
        
        if (result.error) {
            console.error(`Error preparing batch character extraction: ${result.error}`);
            alert(`Error preparing batch character extraction: ${result.error}`);
            return false;
        }
        
        const { promptFile, chapterCount } = result;
        
        // Convert Windows path to WSL path
        const isWindows = process.platform === 'win32';
        let wslPromptFile = promptFile;
        
        if (isWindows) {
            // Convert C:\Users\... to /mnt/c/Users/...
            wslPromptFile = promptFile.replace(/^([A-Z]):\\/, (match, drive) => `/mnt/${drive.toLowerCase()}/`);
            wslPromptFile = wslPromptFile.replace(/\\/g, '/');
        }
        
        // Save the characters.json directly in the audiobook folder
        const localOutputFile = path.join(bookPath, 'characters.json');
        
        let wslOutputFile = localOutputFile;
        if (isWindows) {
            // Convert Windows path to WSL path
            wslOutputFile = localOutputFile.replace(/^([A-Z]):\\/, (match, drive) => `/mnt/${drive.toLowerCase()}/`);
            wslOutputFile = wslOutputFile.replace(/\\/g, '/');
        }
        
        // Use the module to build the CLI command
        const { command, commandOptions } = characterExtractionCLI.buildCLICommand(
            globalAITerminal.currentTool,
            wslPromptFile,
            wslOutputFile
        );
        
        // Show progress in terminal
        globalAITerminal.terminal.writeln(`\n\x1b[33mBatch extracting characters from ${chapterCount} chapters...\x1b[0m`);
        globalAITerminal.terminal.writeln(`\x1b[90mUsing ${globalAITerminal.currentTool === 'claude' ? 'Claude Code' : 'Gemini CLI'}\x1b[0m`);
        globalAITerminal.terminal.writeln(`\x1b[90mChapters: ${chaptersData.map(c => c.title).join(', ')}\x1b[0m`);
        
        // Debug paths
        console.log('Debug paths:', {
            promptFile,
            wslPromptFile,
            localOutputFile,
            wslOutputFile
        });
        
        // Send the command
        const success = globalAITerminal.sendCommand(command, commandOptions);
        
        if (!success) {
            throw new Error('Failed to send command to AI terminal');
        }
        
        // Show status message
        const statusDiv = document.createElement('div');
        statusDiv.className = 'extraction-status';
        statusDiv.innerHTML = `
            <div style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); 
                 background: #2a2a2a; color: white; padding: 20px; border-radius: 8px; 
                 box-shadow: 0 4px 12px rgba(0,0,0,0.5); z-index: 10000;">
                <h3 style="margin: 0 0 10px 0;">Batch Character Extraction</h3>
                <p style="margin: 0;">Processing ${chapterCount} chapters with ${globalAITerminal.currentTool === 'claude' ? 'Claude Code' : 'Gemini CLI'}...</p>
                <div style="margin-top: 10px; font-size: 12px; color: #aaa;">This may take a few moments...</div>
            </div>
        `;
        document.body.appendChild(statusDiv);
        
        // Wait for command completion with a longer timeout for batch extraction
        await new Promise(resolve => setTimeout(resolve, 10000 + (chapterCount * 2000)));
        
        // Remove status
        statusDiv.remove();
        
        // Check if the file was created
        let extractionSuccess = false;
        
        console.log('Checking for output file at:', localOutputFile);
        globalAITerminal.terminal.writeln(`\x1b[90mChecking for output at: ${localOutputFile}\x1b[0m`);
        
        if (fs.existsSync(localOutputFile)) {
            // Use the module to validate the output
            try {
                const validation = await characterExtractionCLI.validateCharacterOutput(localOutputFile);
                
                if (validation.success) {
                    globalAITerminal.terminal.writeln(`\x1b[32m✓ Batch character extraction completed successfully!\x1b[0m`);
                    globalAITerminal.terminal.writeln(`\x1b[90mFound ${validation.count} characters across ${chapterCount} chapters\x1b[0m`);
                    extractionSuccess = true;
                } else {
                    console.error('Invalid character output:', validation.error);
                    globalAITerminal.terminal.writeln(`\x1b[31m✗ Batch character extraction error: ${validation.error}\x1b[0m`);
                    alert(`Batch character extraction error: ${validation.error}`);
                }
            } catch (e) {
                console.error('Error validating output file:', e);
                globalAITerminal.terminal.writeln(`\x1b[31m✗ Error processing output file: ${e.message}\x1b[0m`);
            }
        } else {
            globalAITerminal.terminal.writeln(`\x1b[31m✗ Batch character extraction failed - no output file created\x1b[0m`);
            globalAITerminal.terminal.writeln(`\x1b[90mPlease check the terminal output for errors\x1b[0m`);
        }
        
        // Clean up the prompt file
        // TODO: Re-enable cleanup after ensuring Claude has finished reading the file
        // For now, commenting out to debug file access issues
        /*
        try {
            if (fs.existsSync(promptFile)) {
                fs.unlinkSync(promptFile);
            }
        } catch (e) {
            console.error('Failed to clean up prompt file:', e);
        }
        */
        
        return extractionSuccess;
        
    } catch (error) {
        console.error(`Error in batch CLI character extraction:`, error);
        console.error('Error stack:', error.stack);
        
        // More specific error handling
        if (error.message.includes('IPC') || error.message.includes('Maximum call stack')) {
            alert('Error: Data too large for batch processing. Try processing fewer chapters at once.');
        } else {
            alert(`Error in batch character extraction: ${error.message}`);
        }
        
        // Try to clean up any partial state
        if (globalAITerminal && globalAITerminal.terminal) {
            globalAITerminal.terminal.writeln(`\x1b[31m✗ Batch extraction failed: ${error.message}\x1b[0m`);
        }
        
        return false;
    }
}

// Storyboard Generation Functions
async function generateStoryboardsBatch(book, chaptersToProcess) {
    try {
        const bookPath = path.join(audiobooksDir, book);
        const storyboardsDir = path.join(bookPath, 'storyboards');
        
        // Create storyboards directory if it doesn't exist
        if (!fs.existsSync(storyboardsDir)) {
            fs.mkdirSync(storyboardsDir, { recursive: true });
        }
        
        // Load existing characters for this book
        const globalCharsPath = getCharactersFilePath(book);
        let globalCharacters = [];
        try {
            if (fs.existsSync(globalCharsPath)) {
                const fileContent = fs.readFileSync(globalCharsPath, 'utf-8');
                if (fileContent) {
                    globalCharacters = JSON.parse(fileContent);
                }
            }
        } catch (e) {
            console.error(`Error reading characters.json for book "${book}":`, e);
            alert('Warning: Could not load character data. Storyboards may not have consistent character appearances.');
        }
        
        // Load chapters.json to get chapter indices
        const chaptersJsonPath = path.join(bookPath, 'chapters.json');
        let allChapters = [];
        if (fs.existsSync(chaptersJsonPath)) {
            allChapters = JSON.parse(fs.readFileSync(chaptersJsonPath, 'utf-8'));
        }
        
        // Prepare chapter data with segments
        const chaptersData = [];
        for (const chapterTitle of chaptersToProcess) {
            const chapterIndex = allChapters.findIndex(c => c.title === chapterTitle);
            if (chapterIndex === -1) continue;
            
            const segmentsPath = path.join(bookPath, `${chapterTitle}.segments.json`);
            if (!fs.existsSync(segmentsPath)) {
                console.log(`Skipping ${chapterTitle} - no segments found`);
                globalAITerminal.terminal.writeln(`\x1b[33m⚠ Skipping ${chapterTitle} - no segments found\x1b[0m`);
                continue;
            }
            
            const transcriptPath = path.join(bookPath, `${chapterTitle}.txt`);
            if (!fs.existsSync(transcriptPath)) {
                console.log(`Skipping ${chapterTitle} - no transcript found`);
                globalAITerminal.terminal.writeln(`\x1b[33m⚠ Skipping ${chapterTitle} - no transcript found\x1b[0m`);
                continue;
            }
            
            const segments = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
            const transcript = fs.readFileSync(transcriptPath, 'utf-8');
            
            chaptersData.push({
                title: chapterTitle,
                number: chapterIndex + 1,
                segments: segments,
                transcript: transcript
            });
        }
        
        if (chaptersData.length === 0) {
            alert('No chapters with required data (segments and transcript) found for storyboard generation.');
            return false;
        }
        
        // AI terminal should already be connected from the check above
        
        // Add a small delay to let the UI breathe before heavy operation
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Generate storyboard generation instructions
        const promptFile = await generateStoryboardPrompt(book, chaptersData, globalCharacters);
        
        // Convert Windows path to WSL path
        const isWindows = process.platform === 'win32';
        let wslPromptFile = promptFile;
        
        if (isWindows) {
            // Convert C:\Users\... to /mnt/c/Users/...
            wslPromptFile = promptFile.replace(/^([A-Z]):\\/, (match, drive) => `/mnt/${drive.toLowerCase()}/`);
            wslPromptFile = wslPromptFile.replace(/\\/g, '/');
        }
        
        // Create output file path
        const outputFile = promptFile.replace('_prompt.txt', '_output.json');
        let wslOutputFile = outputFile;
        if (isWindows) {
            wslOutputFile = outputFile.replace(/^([A-Z]):\\/, (match, drive) => `/mnt/${drive.toLowerCase()}/`);
            wslOutputFile = wslOutputFile.replace(/\\/g, '/');
        }
        
        // Build the CLI command
        let command = '';
        const commandOptions = {};
        
        if (globalAITerminal.currentTool === 'claude') {
            command = `Read and analyze the storyboard generation prompt file at ${wslPromptFile} and generate the storyboard data as requested. Save the output JSON array to ${wslOutputFile}`;
            commandOptions.execute = false;
        } else if (globalAITerminal.currentTool === 'gemini') {
            command = `cat "${wslPromptFile}" | gemini "Please analyze this storyboard generation request and generate the storyboard data as requested. Output only the JSON array with no additional text." > "${wslOutputFile}"`;
            commandOptions.execute = true;
        }
        
        // Show progress in terminal
        globalAITerminal.terminal.writeln(`\n\x1b[36m📋 Generating storyboards for ${chaptersData.length} chapter(s)...\x1b[0m`);
        globalAITerminal.terminal.writeln(`\x1b[90mUsing ${globalAITerminal.currentTool === 'claude' ? 'Claude Code' : 'Gemini CLI'}\x1b[0m`);
        globalAITerminal.terminal.writeln(`\x1b[90mCharacters available: ${globalCharacters.length}\x1b[0m`);
        globalAITerminal.terminal.writeln(`\x1b[90mChapters: ${chaptersData.map(c => c.title).join(', ')}\x1b[0m`);
        
        // Send the command
        const success = globalAITerminal.sendCommand(command, commandOptions);
        
        if (!success) {
            throw new Error('Failed to send command to AI terminal');
        }
        
        // Show status message
        const statusDiv = document.createElement('div');
        statusDiv.className = 'extraction-status';
        statusDiv.innerHTML = `
            <div style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); 
                 background: #2a2a2a; color: white; padding: 20px; border-radius: 8px; 
                 box-shadow: 0 4px 12px rgba(0,0,0,0.5); z-index: 10000;">
                <h3 style="margin: 0 0 10px 0;">Generating Storyboards</h3>
                <p style="margin: 0;">Processing ${chaptersData.length} chapters with ${globalAITerminal.currentTool === 'claude' ? 'Claude Code' : 'Gemini CLI'}...</p>
                <div style="margin-top: 10px; font-size: 12px; color: #aaa;">This may take a few minutes...</div>
            </div>
        `;
        document.body.appendChild(statusDiv);
        
        // Wait longer for storyboard generation (it's more complex than character extraction)
        await new Promise(resolve => setTimeout(resolve, 20000));
        
        // Check for output multiple times
        let storyboardSuccess = false;
        let checkAttempts = 0;
        const maxAttempts = 30; // 30 attempts * 2 seconds = 1 minute
        
        globalAITerminal.terminal.writeln(`\x1b[90mWaiting for storyboard generation to complete...\x1b[0m`);
        
        while (checkAttempts < maxAttempts && !storyboardSuccess) {
            console.log('Checking for output file at:', outputFile);
            
            if (fs.existsSync(outputFile)) {
                try {
                    const storyboardData = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
                    
                    if (Array.isArray(storyboardData) && storyboardData.length > 0) {
                        // Process and save individual storyboard files
                        console.log('Processing storyboard data, found chapters:', storyboardData.map(s => s.chapter));
                        
                        for (const chapterStoryboard of storyboardData) {
                            const storyboardPath = path.join(storyboardsDir, `${chapterStoryboard.chapter}.json`);
                            console.log('Saving storyboard to:', storyboardPath);
                            fs.writeFileSync(storyboardPath, JSON.stringify(chapterStoryboard, null, 2));
                        }
                        
                        globalAITerminal.terminal.writeln(`\x1b[32m✓ Storyboard generation completed successfully!\x1b[0m`);
                        globalAITerminal.terminal.writeln(`\x1b[90mGenerated storyboards for ${storyboardData.length} chapters\x1b[0m`);
                        storyboardSuccess = true;
                        
                        // Clean up files
                        try {
                            fs.unlinkSync(promptFile);
                            fs.unlinkSync(outputFile);
                        } catch (e) {
                            console.error('Failed to clean up files:', e);
                        }
                    } else {
                        throw new Error('Invalid storyboard data format');
                    }
                } catch (e) {
                    console.error('Error processing storyboard output:', e);
                    if (checkAttempts === maxAttempts - 1) {
                        globalAITerminal.terminal.writeln(`\x1b[31m✗ Error processing storyboard output: ${e.message}\x1b[0m`);
                    }
                }
            }
            
            if (!storyboardSuccess) {
                checkAttempts++;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        // Remove status message
        statusDiv.remove();
        
        if (!storyboardSuccess) {
            globalAITerminal.terminal.writeln(`\x1b[31m✗ Storyboard generation timed out or failed\x1b[0m`);
            globalAITerminal.terminal.writeln(`\x1b[90mPlease check the terminal output for errors\x1b[0m`);
        }
        
        return storyboardSuccess;
        
    } catch (error) {
        console.error(`Error in batch storyboard generation:`, error);
        alert(`Error in storyboard generation: ${error.message}`);
        return false;
    }
}

// Create storyboard template with embedded segments
async function createStoryboardTemplate(book, chaptersData) {
    const bookPath = path.join(audiobooksDir, book);
    const storyboardsDir = path.join(bookPath, 'storyboards');
    
    // Ensure storyboards directory exists
    if (!fs.existsSync(storyboardsDir)) {
        fs.mkdirSync(storyboardsDir, { recursive: true });
    }
    
    // Load the story board art style tags
    let artStyleTags = [...defaultStoryboardTags]; // Use default story board tags as fallback
    try {
        const savedTags = await ipcRenderer.invoke('get-storyboard-tags', book);
        if (savedTags && savedTags.success && savedTags.tags) {
            artStyleTags = savedTags.tags;
        }
    } catch (error) {
        console.log('Using default story board tags for template:', error);
    }
    
    // Create template for each chapter
    for (const chapterData of chaptersData) {
        const chapterNumber = chapterData.number;
        const templatePath = path.join(storyboardsDir, `Chapter ${chapterNumber}.json`);
        
        // Load segments for this chapter
        const segmentsPath = path.join(bookPath, `${chapterData.title}.segments.json`);
        if (!fs.existsSync(segmentsPath)) {
            console.log(`Segment file not found: ${segmentsPath}`);
            continue;
        }
        
        const segments = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
        
        // Calculate scenes based on 20-second max duration
        const scenes = [];
        let currentSceneStart = segments[0].start;
        let currentSceneSegments = [];
        let sceneCount = 1;
        
        segments.forEach((segment, index) => {
            currentSceneSegments.push(segment.id);
            
            // Check if we should end current scene
            const sceneDuration = segment.end - currentSceneStart;
            const isLastSegment = index === segments.length - 1;
            
            if (sceneDuration >= 20 || isLastSegment) {
                // Get the actual segments for this scene
                const sceneSegments = segments.filter(s => currentSceneSegments.includes(s.id));
                const segmentTexts = sceneSegments.map(s => s.text).join(' ');
                
                scenes.push({
                    sceneId: `ch${chapterNumber}_scene${sceneCount}`,
                    startTime: currentSceneStart,
                    endTime: segment.end,
                    segmentIds: [...currentSceneSegments],
                    segmentText: segmentTexts, // Include full text for AI reference
                    parameters: {
                        artStyle: artStyleTags.join(', '),
                        camera: "[TO BE FILLED: e.g., 'wide shot', 'close-up', 'medium shot', 'over-the-shoulder', 'aerial view']",
                        environment: "[TO BE FILLED: e.g., 'Roman Forum', 'villa interior', 'street market', 'temple courtyard']",
                        background: "[TO BE FILLED: Describe what's visible in the background]",
                        foreground: "[TO BE FILLED: Describe what's visible in the foreground]",
                        mood: "[TO BE FILLED: e.g., 'tense', 'peaceful', 'chaotic', 'mysterious', 'celebratory']",
                        characters: [],
                        characterPoses: {
                            character1: "[TO BE FILLED: Describe pose/action for first character if present]",
                            character2: "[TO BE FILLED: Describe pose/action for second character if present]"
                        }
                    }
                });
                
                // Start next scene
                if (!isLastSegment) {
                    currentSceneStart = segment.end;
                    currentSceneSegments = [];
                    sceneCount++;
                }
            }
        });
        
        // Create template structure with instructions
        const template = {
            "_instructions": [
                "STORYBOARD COMPLETION INSTRUCTIONS:",
                "1. This file contains pre-populated scenes with 'segmentText' showing what the narrator is saying",
                "2. For each scene, fill in the parameters:",
                "   - camera: Choose appropriate shot type (wide shot, close-up, medium shot, over-the-shoulder, aerial view, etc.)",
                "   - environment: Specify the location (e.g., Roman Forum, villa interior, street market, temple courtyard)",
                "   - background: Describe what's visible in the background of the shot",
                "   - foreground: Describe what's visible in the foreground of the shot",
                "   - mood: Describe the emotional tone (e.g., tense, peaceful, chaotic, mysterious, celebratory)",
                "   - characters: Add 0-2 character names from characters.json (MAXIMUM 2 - Kontext limitation!)",
                "   - characterPoses.character1: If characters[0] exists, describe their pose/action",
                "   - characterPoses.character2: If characters[1] exists, describe their pose/action",
                "   - DELETE the segmentText field after using it",
                "3. Character guidelines:",
                "   - ONLY use character names from the characters.json file",
                "   - Maximum 2 characters per scene (technical limitation)",
                "   - For character poses, describe actions, body language, and emotions",
                "   - DO NOT describe main character physical appearances",
                "4. Art Style is pre-filled from global settings - DO NOT MODIFY",
                "5. DELETE this _instructions field when complete",
                "6. Save this file when complete (same filename)",
                "",
                "CRITICAL: All parameters MUST match what is being narrated at those exact timestamps!"
            ],
            "data": [{
                chapter: `Chapter ${chapterNumber}`,
                chapterNumber: chapterNumber,
                scenes: scenes
            }]
        };
        
        // Write template file
        fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
    }
}

async function generateStoryboardPrompt(book, chaptersData, characters) {
    // Use the audiobook's storyboard directory for the prompt file
    const bookPath = path.join(audiobooksDir, book);
    const storyboardsDir = path.join(bookPath, 'storyboards');
    
    // Create templates as Chapter X.json files with embedded instructions
    await createStoryboardTemplate(book, chaptersData);
    
    // Return the first chapter file as the prompt
    // The AI will see the instructions and complete all chapter files
    if (chaptersData.length > 0) {
        return path.join(storyboardsDir, `Chapter ${chaptersData[0].number}.json`);
    }
    
    // Fallback to old prompt style if no chapters
    const timestamp = Date.now();
    const promptFile = path.join(storyboardsDir, `complete_storyboards_${timestamp}.txt`);
    
    let prompt = `Complete the storyboard files for "${book}".

CRITICAL TIMING REQUIREMENT:
- Each scene's parameters MUST accurately depict what is happening during its specific timestamps
- Read the exact words being spoken in the segments for that time period
- The visual parameters MUST match what the narrator is describing at that moment
- DO NOT fill parameters based on overall story context if they don't match the current narration

IMPORTANT INSTRUCTIONS:
1. For each chapter, scenes are pre-created with proper timing - DO NOT modify timing
2. For each scene, you must fill in these parameters:
   - camera: The shot type (wide shot, close-up, medium shot, etc.)
   - environment: The location where the scene takes place
   - background: What's visible in the background
   - foreground: What's visible in the foreground
   - mood: The emotional tone of the scene
   - characters: 0-2 character names from characters.json
   - characterPoses: Descriptions of each character's pose/action
3. Parameter Guidelines:
   - Keep each parameter concise but descriptive
   - Use cinematic terminology for camera angles
   - Be specific about spatial relationships
   - Focus on visual elements, not narrative
4. Character Rules:
   - ONLY use character names from the provided character library
   - Maximum 2 characters per scene (Kontext limitation)
   - For poses, describe actions and body language, NOT appearances
5. DO NOT modify the artStyle parameter - it's pre-filled from settings

PARAMETER FILLING GUIDELINES:
- Camera: Use standard film terminology (wide shot, close-up, medium shot, over-the-shoulder, etc.)
- Environment: Be specific about the location type and any notable features
- Background: Describe architectural elements, distant objects, other people, sky/weather
- Foreground: Describe immediate objects, props, or environmental details in front
- Mood: Use emotional/atmospheric descriptors that match the narration
- Characters: Use exact names from characters.json (case-sensitive)
- Character Poses: Describe body position, gestures, facial expression, and action

PERIOD ACCURACY FOR ANCIENT ROME:
- Background characters wear togas, tunics, stolas (women's dress), or appropriate slave/merchant clothing
- No modern elements (no suits, tuxedos, jeans, t-shirts, etc.)
- Architecture: marble, stone, columns, mosaics, frescoes, oil lamps, braziers
- Objects: clay amphorae, wooden furniture, bronze items, scrolls, wax tablets

Example GOOD parameters:
{
  "camera": "wide shot",
  "environment": "Roman Forum marketplace at midday",
  "background": "Weathered marble columns, wooden market stalls with pottery and fabrics, citizens in togas and stolas moving through plaza",
  "foreground": "Wooden merchant's table with scattered coins and ledger",
  "mood": "tense, confrontational",
  "characters": ["Marcus", "Gaius"],
  "characterPoses": {
    "character1": "leaning forward with hands pressed on table, jaw clenched in frustration",
    "character2": "standing behind table, gesturing dismissively with raised hand"
  }
}

FILES PROVIDED:
1. Character Library: ${path.join(bookPath, 'characters.json')}
   - Contains all available characters with their names and descriptions
   - ONLY use characters from this file

2. Storyboard Files to Complete:
`;
    
    // List the chapter files
    chaptersData.forEach((chapter, index) => {
        const chapterFile = path.join(bookPath, 'storyboards', `Chapter ${chapter.number}.json`);
        prompt += `   - ${chapterFile}\n`;
    });
    
    prompt += `\nYOUR TASK:
1. DO NOT EDIT THIS PROMPT FILE - Edit the Chapter JSON files listed above
2. Open each Chapter [number].json file (e.g., ${path.join(bookPath, 'storyboards', 'Chapter 1.json')})
3. Each scene contains "segmentText" showing what the narrator is saying
4. Fill in all the [TO BE FILLED...] parameter placeholders:
   - Read the segmentText to understand the scene
   - Fill each parameter based on what's happening at that moment
   - Add 0-2 character names to the characters array
   - Fill characterPoses only for characters you've added
5. CRITICAL: artStyle is pre-filled - DO NOT MODIFY IT
6. Remove the "segmentText" field after using it
7. Save the EDITED Chapter file back to its original location
8. DO NOT save your output to this prompt file`;
    
    prompt += `\n\nCRITICAL REMINDERS: 
- Scenes are pre-timed - DO NOT modify timestamps
- Fill ALL parameters for EVERY scene
- Parameters MUST match what is being narrated at those exact timestamps
- Read the segmentText carefully before filling parameters
- If the narrator says "I felt glum" at 2:35, the mood should be "glum" or "melancholic"
- Include atmospheric scenes with 0 characters to establish setting
- Only use character names that exist in the CHARACTER LIBRARY
- MAXIMUM 2 CHARACTERS PER SCENE (technical limitation)
- artStyle parameter is pre-filled from settings - DO NOT CHANGE IT
- Delete segmentText after using it as reference
- Keep parameters concise but descriptive

CRITICAL FILE HANDLING:
- Files are already named correctly: "Chapter [number].json"
- Open, modify, and save back to the SAME filename
- DO NOT create new files or change filenames
- DO NOT output to this prompt file
- Location: ${path.join(bookPath, 'storyboards')}
- Each file already has:
  - Proper scene timing with no gaps
  - segmentText showing what's being narrated
  - Placeholder descriptions to replace

REMEMBER: You are EDITING the Chapter JSON files, not creating new output. Open Chapter 1.json, edit it, save it. Open Chapter 2.json, edit it, save it. And so on.`;
    
    // Write the prompt file
    fs.writeFileSync(promptFile, prompt);
    
    return promptFile;
}

// Scene image generation using FLUX Kontext
async function generateSceneImage(scene, sceneIndex) {
    try {
        // Check if we're using RunPod - if so, skip local model validation
        const currentService = await ipcRenderer.invoke('get-generation-service');
        if (currentService !== 'runpod') {
            // Check required models (only for local generation)
            const requiredModels = ['clip_l', 'ae'];
            const textEncoder = fluxSettings.modelPrecision === 'fp16' ? 't5xxl_fp16' : 't5xxl_fp8';
            const fluxModel = fluxSettings.modelPrecision === 'fp8' ? 'flux_kontext_fp8' : 'flux_kontext';
            
            requiredModels.push(textEncoder, fluxModel);
            
            const missingModels = requiredModels.filter(key => !fluxModelsStatus[key]?.available);
            if (missingModels.length > 0) {
                alert(`Please download required models first: ${missingModels.map(k => fluxModelsStatus[k]?.name).join(', ')}`);
                return;
            }
        }
        
        // Build prompt from parameters or use description for backwards compatibility
        let promptText;
        if (scene.parameters) {
            // New parameter-based format
            const params = scene.parameters;
            
            // Build the prompt from parameters
            let promptParts = [];
            
            // Art style tags first
            promptParts.push(params.artStyle);
            
            // Camera angle
            promptParts.push(params.camera);
            
            // Environment and setting
            promptParts.push(`${params.environment}`);
            
            // Mood
            promptParts.push(`${params.mood} mood`);
            
            // Foreground elements
            if (params.foreground) {
                promptParts.push(`foreground: ${params.foreground}`);
            }
            
            // Background elements
            if (params.background) {
                promptParts.push(`background: ${params.background}`);
            }
            
            // Character poses
            const characters = params.characters || [];
            if (characters.length > 0 && params.characterPoses) {
                if (characters[0] && params.characterPoses.character1) {
                    promptParts.push(`${characters[0]}: ${params.characterPoses.character1}`);
                }
                if (characters[1] && params.characterPoses.character2) {
                    promptParts.push(`${characters[1]}: ${params.characterPoses.character2}`);
                }
            }
            
            promptText = promptParts.join(', ');
        } else {
            // Old description format (backwards compatible)
            promptText = scene.description;
        }
        
        // Get character images for Kontext
        const characterImages = [];
        const sceneCharacters = scene.parameters?.characters || scene.characters;
        if (sceneCharacters && sceneCharacters.length > 0) {
            const globalCharsPath = getCharactersFilePath(currentBook);
            const globalCharacters = JSON.parse(fs.readFileSync(globalCharsPath, 'utf-8'));
            
            for (let i = 0; i < Math.min(2, sceneCharacters.length); i++) {
                const charName = sceneCharacters[i];
                const character = globalCharacters.find(c => c.name === charName);
                
                if (character && character.photo && character.photo !== 'placeholder.png') {
                    const photoPath = path.join(audiobooksDir, currentBook, character.photo);
                    if (fs.existsSync(photoPath)) {
                        characterImages.push({
                            name: charName,
                            path: photoPath
                        });
                    }
                }
            }
        }
        
        // Show loading state
        const generateBtn = document.querySelector(`[data-scene-index="${sceneIndex}"]`);
        if (generateBtn) {
            generateBtn.textContent = 'Generating...';
            generateBtn.disabled = true;
        }
        
        // Generate the image using FLUX Kontext if characters are available
        let result;
        
        if (characterImages.length > 0) {
            // Always use Kontext workflow for character consistency
            // It works with 1 or 2 characters
            const char1Base64 = characterImages[0] ? await imagePathToBase64(characterImages[0].path) : null;
            const char2Base64 = characterImages[1] ? await imagePathToBase64(characterImages[1].path) : null;
            
            // Use appropriate Kontext workflow based on number of characters
            if (char1Base64 && !char2Base64 && characterImages.length === 1) {
                // Use single character Kontext workflow
                result = await ipcRenderer.invoke('flux-generate-kontext-single', {
                    prompt: promptText,
                    character_image: char1Base64,
                    settings: {
                        ...fluxSettings,
                        width: 1456,
                        height: 720
                    }
                });
            } else if (char1Base64 && char2Base64) {
                // Use dual character Kontext workflow
                result = await ipcRenderer.invoke('flux-generate-kontext', {
                    prompt: promptText,
                    character_image_1: char1Base64,
                    character_image_2: char2Base64,
                    settings: {
                        ...fluxSettings,
                        width: 1456,
                        height: 720
                    }
                });
            } else {
                throw new Error('Failed to load character images');
            }
        } else {
            // Use standard FLUX generation
            result = await ipcRenderer.invoke('flux-generate-image', {
                prompt: promptText,
                settings: {
                    ...fluxSettings,
                    width: 1456,
                    height: 720
                }
            });
        }
        
        if (result.error) {
            throw new Error(result.error);
        }
        
        // Poll for completion
        const jobId = result.job_id;
        let completed = false;
        let attempts = 0;
        const maxAttempts = 120; // 10 minutes
        
        while (!completed && attempts < maxAttempts) {
            const status = await ipcRenderer.invoke('flux-get-job-status', { jobId });
            
            if (status.error) {
                throw new Error(status.error);
            }
            
            if (status.status === 'completed') {
                completed = true;
                
                // Get the generated image
                const imageBuffer = await ipcRenderer.invoke('flux-get-image', { jobId });
                if (imageBuffer && !imageBuffer.error) {
                    // Save the image to the storyboards folder
                    const storyboardImagesDir = path.join(audiobooksDir, currentBook, 'storyboards', 'images');
                    if (!fs.existsSync(storyboardImagesDir)) {
                        fs.mkdirSync(storyboardImagesDir, { recursive: true });
                    }
                    
                    const imageFileName = `${scene.sceneId}.png`;
                    const targetPath = path.join(storyboardImagesDir, imageFileName);
                    
                    // Write the buffer to file
                    fs.writeFileSync(targetPath, Buffer.from(imageBuffer));
                    
                    // Update the storyboard data
                    scene.imageGenerated = true;
                    scene.imagePath = path.join('storyboards', 'images', imageFileName);
                    
                    // Save updated storyboard data
                    const chapterMatch = chapters[currentChapterIndex].title.match(/Chapter (\d+)/i);
                    const simpleChapterName = chapterMatch ? `Chapter ${chapterMatch[1]}` : chapters[currentChapterIndex].title;
                    const storyboardPath = path.join(audiobooksDir, currentBook, 'storyboards', `${simpleChapterName}.json`);
                    const storyboardData = JSON.parse(fs.readFileSync(storyboardPath, 'utf-8'));
                    
                    // Handle both old and new storyboard formats
                    if (Array.isArray(storyboardData) && storyboardData.length > 0 && storyboardData[0].scenes) {
                        storyboardData[0].scenes[sceneIndex] = scene;
                    } else if (storyboardData.scenes) {
                        storyboardData.scenes[sceneIndex] = scene;
                    }
                    
                    fs.writeFileSync(storyboardPath, JSON.stringify(storyboardData, null, 2));
                    
                    // Update UI
                    renderStoryboardList();
                    
                    console.log(`Generated image for scene ${scene.sceneId}`);
                }
            } else if (status.status === 'failed') {
                throw new Error(status.error || 'Generation failed');
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds between checks
        }
        
        if (!completed) {
            throw new Error('Image generation timed out');
        }
        
    } catch (error) {
        console.error('Error generating scene image:', error);
        alert(`Failed to generate image: ${error.message}`);
        
        // Reset button state
        const generateBtn = document.querySelector(`[data-scene-index="${sceneIndex}"]`);
        if (generateBtn) {
            generateBtn.textContent = 'Generate Image';
            generateBtn.disabled = false;
        }
    }
}

async function loadChapters(book) {
    if (isLoadingChapters) {
        return;
    }
    
    try {
        isLoadingChapters = true;
        currentBook = book;
        const bookDir = path.join(audiobooksDir, book);
        const chaptersJsonPath = path.join(bookDir, 'chapters.json');

        let needsRegeneration = false;

        if (fs.existsSync(chaptersJsonPath)) {
            // Load chapters from chapters.json
            chapters = JSON.parse(fs.readFileSync(chaptersJsonPath, 'utf-8'));
            
            // Validate that all referenced MP3 files exist
            for (const chapter of chapters) {
                const mp3FileName = `${chapter.title}.mp3`;
                const mp3FilePath = path.join(bookDir, mp3FileName);
                if (!fs.existsSync(mp3FilePath)) {
                    needsRegeneration = true;
                    break;
                }
            }
        } else {
            needsRegeneration = true;
        }

        if (needsRegeneration) {
            // Generate chapters from MP3 files and save to chapters.json
            const files = fs.readdirSync(bookDir);
            chapters = files
                .filter(file => file.endsWith('.mp3') || file.endsWith('.MP3'))
                .map(file => {
                    const filePath = path.join(bookDir, file);
                    // Properly encode the file URI for Windows
                    const fileUri = `file:///${filePath.replace(/\\/g, '/')}`;
                    return {
                        title: path.basename(file, path.extname(file)),
                        audio: fileUri
                    };
                })
                .sort((a, b) => {
                    // Natural sort that handles numbers properly
                    return a.title.localeCompare(b.title, undefined, {
                        numeric: true,
                        sensitivity: 'base'
                    });
                });
            
            saveChaptersMetadata(bookDir, chapters);
        }

        if (chapters.length > 0) {
            playChapter(0);
            loadCharacters(book); // Load characters for the book
        } else {
            alert('No MP3 files found in the selected book directory.');
        }
    } catch (error) {
        alert(`Error loading chapters: ${error.message}`);
    } finally {
        isLoadingChapters = false;
    }
}

function saveChaptersMetadata(bookDir, chaptersData) {
    const chaptersJsonPath = path.join(bookDir, 'chapters.json');
    fs.writeFileSync(chaptersJsonPath, JSON.stringify(chaptersData, null, 2), 'utf-8');
}

function renderCharacters(characters) {
    const characterListDisplay = document.getElementById('character-list-display');
    characterListDisplay.innerHTML = '';

    if (!characters || characters.length === 0) {
        characterListDisplay.textContent = 'No characters found for this book.';
        return;
    }

    characters.forEach(character => {
        const entry = document.createElement('div');
        entry.classList.add('character-entry');

        // Character header with name and image
        const characterHeader = document.createElement('div');
        characterHeader.classList.add('character-header');

        const name = document.createElement('h4');
        name.textContent = character.name;
        characterHeader.appendChild(name);

        const imageContainer = document.createElement('div');
        imageContainer.classList.add('character-image-container');
        
        const img = document.createElement('img');
        const hasProfilePhoto = character.photo && character.photo !== 'placeholder.png';
        
        if (hasProfilePhoto) {
            // Use the saved character image from the book directory
            const bookDir = path.join(audiobooksDir, currentBook);
            img.src = path.join(bookDir, character.photo);
            
            // Make image clickable to open edit modal
            img.style.cursor = 'pointer';
            img.title = 'Click to view and edit character image';
            img.addEventListener('click', (e) => {
                e.stopPropagation();
                openEditCharacterModal(character, img);
            });
        } else {
            // Use the default placeholder
            img.src = 'placeholder.png';
        }
        imageContainer.appendChild(img);
        
        // Add checkbox and Generate Image button only if no profile photo
        if (!hasProfilePhoto) {
            // Add checkbox for batch selection
            const checkboxContainer = document.createElement('div');
            checkboxContainer.classList.add('character-checkbox-container');
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `character-checkbox-${character.name}`;
            checkbox.classList.add('character-batch-checkbox');
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                if (checkbox.checked) {
                    selectedCharactersForBatch.add(character.name);
                } else {
                    selectedCharactersForBatch.delete(character.name);
                }
                
                // Show/hide batch controls
                if (selectedCharactersForBatch.size > 0) {
                    characterBatchMode = true;
                    showCharacterBatchControls();
                    updateCharacterBatchControls();
                } else {
                    cancelCharacterBatchSelection();
                }
            });
            
            const checkboxLabel = document.createElement('label');
            checkboxLabel.htmlFor = checkbox.id;
            checkboxLabel.textContent = 'Select for batch';
            checkboxLabel.classList.add('character-checkbox-label');
            
            checkboxContainer.appendChild(checkbox);
            checkboxContainer.appendChild(checkboxLabel);
            imageContainer.appendChild(checkboxContainer);
            
            // Add individual generate button
            const generateImageBtn = document.createElement('button');
            generateImageBtn.classList.add('generate-image-btn');
            generateImageBtn.textContent = '🎨 Generate Image';
            generateImageBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const imageDescription = character.imagePrompt || character.baseDescription || character.description;
                await generateFluxCharacterImage(character, null, imageDescription, img);
            });
            imageContainer.appendChild(generateImageBtn);
        }
        
        characterHeader.appendChild(imageContainer);
        entry.appendChild(characterHeader);

        // Expandable description box
        const descriptionContainer = document.createElement('div');
        descriptionContainer.classList.add('character-description-container');
        
        const descriptionToggle = document.createElement('button');
        descriptionToggle.classList.add('description-toggle');
        descriptionToggle.textContent = '▶ Show Description';
        descriptionToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isExpanded = descriptionContent.style.display === 'block';
            descriptionContent.style.display = isExpanded ? 'none' : 'block';
            descriptionToggle.textContent = isExpanded ? '▶ Show Description' : '▼ Hide Description';
        });
        descriptionContainer.appendChild(descriptionToggle);
        
        const descriptionContent = document.createElement('div');
        descriptionContent.classList.add('character-description-content');
        descriptionContent.style.display = 'none';
        
        // Add context info if available
        if (character.timePeriod || character.location) {
            const contextInfo = document.createElement('div');
            contextInfo.classList.add('character-context-info');
            
            if (character.timePeriod) {
                const timePeriodSpan = document.createElement('span');
                timePeriodSpan.innerHTML = `<strong>Time Period:</strong> ${character.timePeriod}`;
                contextInfo.appendChild(timePeriodSpan);
            }
            
            if (character.location) {
                const locationSpan = document.createElement('span');
                locationSpan.innerHTML = `<strong>Location:</strong> ${character.location}`;
                contextInfo.appendChild(locationSpan);
            }
            
            descriptionContent.appendChild(contextInfo);
        }
        
        // Display parameters if available, otherwise show old description
        if (character.parameters) {
            const paramsContainer = document.createElement('div');
            paramsContainer.classList.add('character-parameters');
            
            // Identity Section
            const identitySection = document.createElement('div');
            identitySection.classList.add('param-section');
            identitySection.innerHTML = '<h5>Identity</h5>';
            const identity = character.parameters.identity || {};
            identitySection.innerHTML += `
                <div><strong>Role:</strong> ${identity.role || 'not specified'}</div>
                <div><strong>Age:</strong> ${identity.age || 'not specified'}</div>
                <div><strong>Gender:</strong> ${identity.gender || 'not specified'}</div>
            `;
            paramsContainer.appendChild(identitySection);
            
            // Physical Build Section
            const buildSection = document.createElement('div');
            buildSection.classList.add('param-section');
            buildSection.innerHTML = '<h5>Physical Build</h5>';
            const build = character.parameters.physicalBuild || {};
            buildSection.innerHTML += `
                <div><strong>Height:</strong> ${build.height || 'not specified'}</div>
                <div><strong>Build:</strong> ${build.build || 'not specified'}</div>
                <div><strong>Posture:</strong> ${build.posture || 'not specified'}</div>
            `;
            paramsContainer.appendChild(buildSection);
            
            // Facial Features Section
            const faceSection = document.createElement('div');
            faceSection.classList.add('param-section');
            faceSection.innerHTML = '<h5>Facial Features</h5>';
            const face = character.parameters.facialFeatures || {};
            faceSection.innerHTML += `
                <div><strong>Skin Tone:</strong> ${face.skinTone || 'not specified'}</div>
                <div><strong>Face Shape:</strong> ${face.faceShape || 'not specified'}</div>
                <div><strong>Eyes:</strong> ${face.eyes || 'not specified'}</div>
                <div><strong>Hair:</strong> ${face.hair || 'not specified'}</div>
                <div><strong>Facial Hair:</strong> ${face.facialHair || 'not specified'}</div>
                <div><strong>Distinctive Features:</strong> ${face.distinctiveFeatures || 'none'}</div>
            `;
            paramsContainer.appendChild(faceSection);
            
            // Attire Section
            const attireSection = document.createElement('div');
            attireSection.classList.add('param-section');
            attireSection.innerHTML = '<h5>Attire</h5>';
            const attire = character.parameters.attire || {};
            attireSection.innerHTML += `
                <div><strong>Headwear:</strong> ${attire.headwear || 'not specified'}</div>
                <div><strong>Upper Body:</strong> ${attire.upperBody || 'not specified'}</div>
                <div><strong>Lower Body:</strong> ${attire.lowerBody || 'not specified'}</div>
                <div><strong>Footwear:</strong> ${attire.footwear || 'not specified'}</div>
                <div><strong>Accessories:</strong> ${attire.accessories || 'none'}</div>
                <div><strong>Style:</strong> ${attire.clothingStyle || 'not specified'}</div>
                <div><strong>Colors:</strong> ${attire.clothingColors || 'not specified'}</div>
            `;
            paramsContainer.appendChild(attireSection);
            
            // Personality Section
            const personalitySection = document.createElement('div');
            personalitySection.classList.add('param-section');
            personalitySection.innerHTML = '<h5>Personality</h5>';
            const personality = character.parameters.personality || {};
            personalitySection.innerHTML += `
                <div><strong>Demeanor:</strong> ${personality.demeanor || 'not specified'}</div>
                <div><strong>Traits:</strong> ${personality.traits || 'not specified'}</div>
            `;
            paramsContainer.appendChild(personalitySection);
            
            descriptionContent.appendChild(paramsContainer);
        } else {
            // Fallback to old description format
            const description = document.createElement('p');
            description.textContent = character.baseDescription || character.description || 'No description available';
            descriptionContent.appendChild(description);
        }
        
        // Add Regenerate Description button in expanded view
        const regenerateBtn = document.createElement('button');
        regenerateBtn.classList.add('regenerate-description-btn');
        regenerateBtn.textContent = '🔄 Regenerate Description';
        regenerateBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            openRegenerateModal(character);
        });
        descriptionContent.appendChild(regenerateBtn);
        
        // Add character-specific tags container in expanded view
        const charTagsContainer = document.createElement('div');
        charTagsContainer.className = 'character-tags-container';
        
        const charTagsLabel = document.createElement('div');
        charTagsLabel.className = 'character-tags-label';
        charTagsLabel.textContent = 'Character Tags:';
        charTagsContainer.appendChild(charTagsLabel);
        
        const charTagsList = document.createElement('div');
        charTagsList.className = 'character-tags-list';
        
        // Display existing character tags
        const charName = character.name;
        const existingTags = characterTags[charName] || [];
        
        function renderCharacterTags() {
            charTagsList.innerHTML = '';
            existingTags.forEach((tag, index) => {
                const tagElement = document.createElement('div');
                tagElement.className = 'tag character-tag';
                tagElement.innerHTML = `
                    ${tag}
                    <span class="tag-remove" data-char="${charName}" data-index="${index}">×</span>
                `;
                charTagsList.appendChild(tagElement);
            });
            
            // Add click handlers for remove buttons
            charTagsList.querySelectorAll('.tag-remove').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const charName = e.target.dataset.char;
                    const index = parseInt(e.target.dataset.index);
                    const charTags = characterTags[charName] || [];
                    charTags.splice(index, 1);
                    characterTags[charName] = charTags;
                    existingTags.splice(index, 1);
                    renderCharacterTags();
                    
                    // Auto-save tags when modified
                    try {
                        const bookPath = path.join(audiobooksDir, currentBook);
                        const tagsData = {
                            globalTags: currentGlobalTags,
                            characterTags: characterTags
                        };
                        await ipcRenderer.invoke('save-tags', { bookPath, tags: tagsData });
                    } catch (error) {
                        console.error('Error auto-saving tags:', error);
                    }
                });
            });
        }
        
        renderCharacterTags();
        charTagsContainer.appendChild(charTagsList);
        
        // Add input for new tags
        const charTagInput = document.createElement('input');
        charTagInput.type = 'text';
        charTagInput.className = 'character-tag-input';
        charTagInput.placeholder = 'Add character-specific tag...';
        charTagInput.addEventListener('keypress', async (e) => {
            if (e.key === 'Enter') {
                const newTag = charTagInput.value.trim();
                if (newTag && !existingTags.includes(newTag)) {
                    existingTags.push(newTag);
                    characterTags[charName] = existingTags;
                    renderCharacterTags();
                    charTagInput.value = '';
                    
                    // Auto-save tags when modified
                    try {
                        const bookPath = path.join(audiobooksDir, currentBook);
                        const tagsData = {
                            globalTags: currentGlobalTags,
                            characterTags: characterTags
                        };
                        await ipcRenderer.invoke('save-tags', { bookPath, tags: tagsData });
                    } catch (error) {
                        console.error('Error auto-saving tags:', error);
                    }
                }
            }
        });
        charTagsContainer.appendChild(charTagInput);
        
        descriptionContent.appendChild(charTagsContainer);
        descriptionContainer.appendChild(descriptionContent);
        entry.appendChild(descriptionContainer);

        if (character.subCharacteristics && character.subCharacteristics.length > 0) {
            const subList = document.createElement('div');
            subList.classList.add('sub-character-list');

            character.subCharacteristics.forEach(subChar => {
                const subEntry = document.createElement('div');
                subEntry.classList.add('sub-character-entry');

                const subImg = document.createElement('img');
                // Check if the photo path is relative (saved character image) or absolute (placeholder)
                if (subChar.photo && subChar.photo !== 'placeholder.png' && !subChar.photo.startsWith('placeholder_')) {
                    // Use the saved sub-character image from the book directory
                    const bookDir = path.join(audiobooksDir, currentBook);
                    subImg.src = path.join(bookDir, subChar.photo);
                } else {
                    // Use the default placeholder
                    subImg.src = 'placeholder.png';
                }
                subEntry.appendChild(subImg);

                const subInfo = document.createElement('div');
                subInfo.classList.add('sub-character-info');

                const subName = document.createElement('h5');
                subName.textContent = subChar.name;
                subInfo.appendChild(subName);

                // Display parameters if available, otherwise show description
                if (subChar.parameters) {
                    const subParamsContainer = document.createElement('div');
                    subParamsContainer.classList.add('sub-character-parameters');
                    
                    // Create a more compact display for sub-characteristics
                    const paramsList = document.createElement('div');
                    paramsList.classList.add('sub-params-list');
                    
                    // Identity info
                    if (subChar.parameters.identity) {
                        const identity = subChar.parameters.identity;
                        if (identity.role || identity.age || identity.gender) {
                            const identityLine = document.createElement('div');
                            identityLine.innerHTML = `<strong>Identity:</strong> ${[identity.role, identity.age, identity.gender].filter(Boolean).join(', ')}`;
                            paramsList.appendChild(identityLine);
                        }
                    }
                    
                    // Physical build info
                    if (subChar.parameters.physicalBuild) {
                        const build = subChar.parameters.physicalBuild;
                        if (build.height || build.build) {
                            const buildLine = document.createElement('div');
                            buildLine.innerHTML = `<strong>Build:</strong> ${[build.height, build.build].filter(Boolean).join(', ')}`;
                            paramsList.appendChild(buildLine);
                        }
                    }
                    
                    // Key facial features
                    if (subChar.parameters.facialFeatures) {
                        const face = subChar.parameters.facialFeatures;
                        if (face.hair || face.eyes) {
                            const faceLine = document.createElement('div');
                            faceLine.innerHTML = `<strong>Appearance:</strong> ${[face.hair, face.eyes].filter(Boolean).join(', ')}`;
                            paramsList.appendChild(faceLine);
                        }
                    }
                    
                    // Attire summary
                    if (subChar.parameters.attire) {
                        const attire = subChar.parameters.attire;
                        if (attire.clothingStyle || attire.upperBody) {
                            const attireLine = document.createElement('div');
                            attireLine.innerHTML = `<strong>Attire:</strong> ${attire.clothingStyle || attire.upperBody || 'not specified'}`;
                            paramsList.appendChild(attireLine);
                        }
                    }
                    
                    subParamsContainer.appendChild(paramsList);
                    subInfo.appendChild(subParamsContainer);
                } else {
                    // Fallback to old description
                    const subDescription = document.createElement('p');
                    subDescription.textContent = subChar.description;
                    subInfo.appendChild(subDescription);
                }

                // Add Generate Image button for sub-characteristic
                const subGenerateImageBtn = document.createElement('button');
                subGenerateImageBtn.classList.add('generate-image-btn');
                subGenerateImageBtn.textContent = '🎨 Generate Image';
                subGenerateImageBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const imageDescription = subChar.imagePrompt || subChar.description;
                    await generateFluxCharacterImage(character, subChar, imageDescription, subImg);
                });
                subInfo.appendChild(subGenerateImageBtn);

                subEntry.appendChild(subInfo);
                subList.appendChild(subEntry);
            });

            entry.appendChild(subList);
        }

        characterListDisplay.appendChild(entry);
    });
}

async function loadCharacters(book) {
    const bookDir = path.join(audiobooksDir, book);
    const charactersJsonPath = getCharactersFilePath(book);
    let characters = [];
    
    // Load tags for this book
    try {
        const savedTags = await ipcRenderer.invoke('get-tags', bookDir);
        if (savedTags && savedTags.success) {
            currentGlobalTags = savedTags.tags.globalTags || [...defaultTags];
            characterTags = savedTags.tags.characterTags || {};
        }
    } catch (error) {
        console.error('Error loading tags for characters:', error);
    }

    if (fs.existsSync(charactersJsonPath)) {
        try {
            const fileContent = fs.readFileSync(charactersJsonPath, 'utf-8');
            if (fileContent) {
                characters = JSON.parse(fileContent);
            }
        } catch (e) {
            console.error(`Error reading or parsing characters.json for book "${book}":`, e);
        }
    }

    renderCharacters(characters);
    
    // Update FLUX Kontext character selects
    currentCharacters = characters;
    updateKontextCharacterSelects();
}


async function renderBookChaptersInBrowser(book, container) {
    try {
        const bookDir = path.join(audiobooksDir, book);
        const chaptersJsonPath = path.join(bookDir, 'chapters.json');
        let bookChapters = [];
        let needsRegeneration = false;

        if (fs.existsSync(chaptersJsonPath)) {
            bookChapters = JSON.parse(fs.readFileSync(chaptersJsonPath, 'utf-8'));
            
            // Validate that all referenced MP3 files exist
            for (const chapter of bookChapters) {
                const mp3FileName = `${chapter.title}.mp3`;
                const mp3FilePath = path.join(bookDir, mp3FileName);
                if (!fs.existsSync(mp3FilePath)) {
                    needsRegeneration = true;
                    break;
                }
            }
        } else {
            needsRegeneration = true;
        }

        if (needsRegeneration) {
            const files = fs.readdirSync(bookDir);
            bookChapters = files
                .filter(file => file.endsWith('.mp3') || file.endsWith('.MP3'))
                .map(file => {
                    const filePath = path.join(bookDir, file);
                    const fileUri = `file:///${filePath.replace(/\\/g, '/')}`;
                    return {
                        title: path.basename(file, path.extname(file)),
                        audio: fileUri
                    };
                })
                .sort((a, b) => {
                    // Natural sort that handles numbers properly
                    return a.title.localeCompare(b.title, undefined, {
                        numeric: true,
                        sensitivity: 'base'
                    });
                });
            saveChaptersMetadata(bookDir, bookChapters);
        }

        container.innerHTML = ''; // Clear previous chapters
        bookChapters.forEach((chapter, index) => {
            const chapterWrapper = document.createElement('div');
            chapterWrapper.classList.add('chapter-wrapper');

            const chapterItem = document.createElement('div');
            chapterItem.classList.add('chapter-item');

            const chapterControls = document.createElement('div');
            chapterControls.classList.add('chapter-controls');

            const chapterNumber = document.createElement('div');
            chapterNumber.classList.add('chapter-number');
            chapterNumber.textContent = `Chapter ${index + 1}`;
            chapterControls.appendChild(chapterNumber);

            const settingsButton = document.createElement('button');
            settingsButton.classList.add('settings-button');
            settingsButton.addEventListener('click', (event) => {
                event.stopPropagation();
                openChapterSettingsModal(book, index, bookChapters);
            });
            chapterControls.appendChild(settingsButton);
            chapterItem.appendChild(chapterControls);

            const chapterTitleSpan = document.createElement('span');
            chapterTitleSpan.classList.add('chapter-title');
            chapterTitleSpan.textContent = chapter.title;
            chapterItem.appendChild(chapterTitleSpan);

            const buttonsContainer = document.createElement('div');
            buttonsContainer.classList.add('chapter-item-buttons');

            const transcriptionFilePath = path.join(audiobooksDir, book, `${chapter.title}.txt`);

            // Transcribe button (T)
            const transcribeButton = document.createElement('button');
            transcribeButton.classList.add('action-symbol-btn', 'transcribe-btn');
            transcribeButton.textContent = 'T';
            transcribeButton.title = 'Click to transcribe this chapter. Click on multiple chapters to batch transcribe.';
            transcribeButton.dataset.book = book;
            transcribeButton.dataset.chapter = chapter.title;
            
            // Check if transcription already exists
            if (fs.existsSync(transcriptionFilePath)) {
                transcribeButton.classList.add('disabled');
                transcribeButton.disabled = true;
                transcribeButton.title = 'Transcription already exists';
            } 
            // Check if Whisper service is available
            else if (!whisperServiceStatus) {
                transcribeButton.classList.add('disabled');
                transcribeButton.disabled = true;
                transcribeButton.title = 'AI Services not available';
            }
            
            transcribeButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                await handleActionClick('transcribe', book, chapter, container, chapterItem);
            });
            buttonsContainer.appendChild(transcribeButton);

            // Character extraction button (C)
            const globalCharsPath = getCharactersFilePath(book);
            let globalCharacters = [];
            try {
                if (fs.existsSync(globalCharsPath)) {
                    const fileContent = fs.readFileSync(globalCharsPath, 'utf-8');
                    if (fileContent) {
                        globalCharacters = JSON.parse(fileContent);
                    }
                }
            } catch (e) {
                console.error(`Error reading or parsing characters.json for book "${book}":`, e);
                globalCharacters = [];
            }
            const isChapterProcessed = globalCharacters.some(c => c.chapters && c.chapters.includes(index + 1));

            const characterButton = document.createElement('button');
            characterButton.classList.add('action-symbol-btn', 'character-btn');
            characterButton.textContent = 'C';
            characterButton.title = 'Click to extract characters from this chapter. Click on multiple chapters to batch extract.';
            characterButton.dataset.book = book;
            characterButton.dataset.chapter = chapter.title;
            
            if (isChapterProcessed) {
                characterButton.classList.add('disabled');
                characterButton.disabled = true;
                characterButton.title = 'Characters already extracted';
            }
            
            characterButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                await handleActionClick('character', book, chapter, container, chapterItem);
            });
            buttonsContainer.appendChild(characterButton);
            
            // Storyboard button (S)
            const storyboardButton = document.createElement('button');
            storyboardButton.classList.add('action-symbol-btn', 'storyboard-btn');
            storyboardButton.textContent = 'S';
            storyboardButton.title = 'Generate storyboard for this chapter';
            storyboardButton.dataset.book = book;
            storyboardButton.dataset.chapter = chapter.title;
            
            // Check if storyboard already exists
            const chapterMatch = chapter.title.match(/Chapter (\d+)/i);
            const simpleChapterName = chapterMatch ? `Chapter ${chapterMatch[1]}` : chapter.title;
            const storyboardPath = path.join(audiobooksDir, book, 'storyboards', `${simpleChapterName}.json`);
            if (fs.existsSync(storyboardPath)) {
                storyboardButton.classList.add('disabled');
                storyboardButton.disabled = true;
                storyboardButton.title = 'Storyboard already generated';
            }
            
            storyboardButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                await handleActionClick('storyboard', book, chapter, container, chapterItem);
            });
            buttonsContainer.appendChild(storyboardButton);
            
            chapterItem.appendChild(buttonsContainer);
            chapterWrapper.appendChild(chapterItem);

			if (isChapterProcessed) {
				const characterToggle = document.createElement('div');
				characterToggle.classList.add('character-toggle');
				chapterItem.insertBefore(characterToggle, chapterTitleSpan);

				const characterListContainer = document.createElement('div');
				characterListContainer.classList.add('character-list-container');

				const characterList = document.createElement('div');
				characterList.classList.add('character-list');

				const charactersInChapter = globalCharacters.filter(gChar => 
					gChar.chapters && gChar.chapters.includes(index + 1)
				);

				charactersInChapter.forEach(character => {
					const characterContainer = document.createElement('div');
					characterContainer.classList.add('character-container');

					// Determine which version of the character appears in this chapter
					let activeCharacterVersion = null;
					let activeDescription = character.baseDescription || character.description;
					let activeName = character.name;
					let activePhoto = character.photo || "placeholder.png";
					
					// Resolve the photo path if it's a saved character image
					if (activePhoto && activePhoto !== 'placeholder.png') {
						const bookDir = path.join(audiobooksDir, book);
						activePhoto = path.join(bookDir, activePhoto);
					}

					// Check if character has sub-characteristics
					if (character.subCharacteristics && character.subCharacteristics.length > 0) {
						// Find which sub-characteristic is active in this chapter
						for (const subChar of character.subCharacteristics) {
							if (subChar.chapters && subChar.chapters.includes(index + 1)) {
								activeCharacterVersion = subChar;
								activeDescription = subChar.description;
								activeName = subChar.name;
								activePhoto = subChar.photo || character.photo || "placeholder.png";
								
								// Resolve the photo path if it's a saved character image
								if (activePhoto && activePhoto !== 'placeholder.png' && !activePhoto.startsWith('placeholder_')) {
									const bookDir = path.join(audiobooksDir, book);
									activePhoto = path.join(bookDir, activePhoto);
								}
								break;
							}
						}
					}

					// Main character card
					const photo = document.createElement('img');
					photo.src = activePhoto;
					photo.classList.add('character-photo');
					characterContainer.appendChild(photo);

					const characterInfo = document.createElement('div');
					characterInfo.classList.add('character-info');

					const name = document.createElement('h4');
					name.textContent = activeName;
					if (activeCharacterVersion) {
						name.classList.add('character-variant');
						// Add age range if available
						if (activeCharacterVersion.ageRange) {
							const ageSpan = document.createElement('span');
							ageSpan.classList.add('character-age');
							ageSpan.textContent = ` (Age: ${activeCharacterVersion.ageRange})`;
							name.appendChild(ageSpan);
						}
					}
					characterInfo.appendChild(name);

					const description = document.createElement('p');
					description.textContent = activeDescription;
					description.classList.add('character-description');
					characterInfo.appendChild(description);

					// Add Generate Image button
					const generateImageBtn = document.createElement('button');
					generateImageBtn.classList.add('generate-image-btn');
					generateImageBtn.textContent = '🎨 Generate Image';
					generateImageBtn.addEventListener('click', async (e) => {
						e.stopPropagation();
						await generateFluxCharacterImage(character, activeCharacterVersion, activeDescription, photo);
					});
					characterInfo.appendChild(generateImageBtn);

					// If this is a sub-characteristic, show trigger event
					if (activeCharacterVersion && activeCharacterVersion.triggerEvent) {
						const triggerEvent = document.createElement('p');
						triggerEvent.classList.add('trigger-event');
						triggerEvent.textContent = `State: ${activeCharacterVersion.triggerEvent}`;
						characterInfo.appendChild(triggerEvent);
					}

					// Show personality traits if available
					if (character.personalityTraits) {
						const traits = document.createElement('p');
						traits.classList.add('personality-traits');
						traits.textContent = `Personality: ${character.personalityTraits}`;
						characterInfo.appendChild(traits);
					}

					// Add expandable section for all character versions
					if (character.subCharacteristics && character.subCharacteristics.length > 0) {
						const versionsToggle = document.createElement('button');
						versionsToggle.classList.add('versions-toggle');
						versionsToggle.textContent = `View all ${character.subCharacteristics.length + 1} versions`;
						characterInfo.appendChild(versionsToggle);

						const versionsContainer = document.createElement('div');
						versionsContainer.classList.add('versions-container');
						versionsContainer.style.display = 'none';

						// Add base version
						const baseVersion = document.createElement('div');
						baseVersion.classList.add('character-version');
						baseVersion.innerHTML = `
							<h5>Base Appearance</h5>
							<p class="version-chapters">Chapters: ${character.chapters.join(', ')}</p>
							<p class="version-description">${character.baseDescription || character.description}</p>
						`;
						versionsContainer.appendChild(baseVersion);

						// Add all sub-characteristics
						character.subCharacteristics.forEach(subChar => {
							const versionDiv = document.createElement('div');
							versionDiv.classList.add('character-version');
							versionDiv.innerHTML = `
								<h5>${subChar.name}</h5>
								<p class="version-age">Age: ${subChar.ageRange || 'Unknown'}</p>
								<p class="version-chapters">Chapters: ${subChar.chapters.join(', ')}</p>
								<p class="version-trigger">Trigger: ${subChar.triggerEvent}</p>
								<p class="version-description">${subChar.description}</p>
							`;
							versionsContainer.appendChild(versionDiv);
						});

						characterInfo.appendChild(versionsContainer);

						versionsToggle.addEventListener('click', (e) => {
							e.stopPropagation();
							const isVisible = versionsContainer.style.display === 'block';
							versionsContainer.style.display = isVisible ? 'none' : 'block';
							versionsToggle.textContent = isVisible 
								? `View all ${character.subCharacteristics.length + 1} versions`
								: 'Hide versions';
						});
					}

					characterContainer.appendChild(characterInfo);
					characterList.appendChild(characterContainer);
				});

				characterListContainer.appendChild(characterList);
				chapterWrapper.appendChild(characterListContainer);

				characterToggle.addEventListener('click', (event) => {
					event.stopPropagation();
					characterToggle.classList.toggle('expanded');
					characterListContainer.style.display = 
						characterListContainer.style.display === 'block' ? 'none' : 'block';
				});
			}

            chapterItem.addEventListener('click', (event) => {
                event.stopPropagation(); // Prevent book item click from firing
                
                // Check if chapters are already loaded for this book
                if (currentBook === book) {
                    // Just play the chapter, don't reload everything
                    const chapterIndexInPlayer = chapters.findIndex(c => c.title === chapter.title);
                    if (chapterIndexInPlayer !== -1) {
                        playChapter(chapterIndexInPlayer);
                    }
                } else {
                    // Load the book's chapters first, then play
                    loadChapters(book).then(() => {
                        const chapterIndexInPlayer = chapters.findIndex(c => c.title === chapter.title);
                        if (chapterIndexInPlayer !== -1) {
                            playChapter(chapterIndexInPlayer);
                        }
                    });
                }
            });
            container.appendChild(chapterWrapper);
        });
    } catch (error) {
        alert(`Error rendering chapters: ${error.message}`);
    }
}

async function loadBooks() {
    try {
        const files = fs.readdirSync(audiobooksDir, { withFileTypes: true });
        const books = files
            .filter(file => file.isDirectory() && file.name !== 'character_extraction_instructions' && !file.name.startsWith('.'))
            .map(dir => dir.name);

        bookList.innerHTML = '';
        books.forEach(book => {
            const bookContainer = document.createElement('div');
            bookContainer.classList.add('book-container');

            const bookItem = document.createElement('div');
            bookItem.classList.add('book-item');
            bookItem.textContent = book;
            bookItem.addEventListener('click', async () => {
                // Toggle active class for styling
                document.querySelectorAll('.book-item').forEach(item => item.classList.remove('active'));
                bookItem.classList.add('active');

                // Toggle visibility of chapters in the browser view
                const chapterListContainer = bookContainer.querySelector('.chapter-list-container');
                const isExpanded = chapterListContainer.style.display === 'block';
                
                if (isExpanded) {
                    // Just collapse, don't reload
                    chapterListContainer.style.display = 'none';
                } else {
                    // Expand and load chapters if needed
                    chapterListContainer.style.display = 'block';
                    
                    // If chapters haven't been loaded for this book in the browser view, load them
                    if (chapterListContainer.children.length === 0) {
                        renderBookChaptersInBrowser(book, chapterListContainer);
                    }
                    
                    // Only load chapters into player if this is a different book
                    if (currentBook !== book) {
                        await loadChapters(book);
                    }
                }
            });
            bookContainer.appendChild(bookItem);

            const chapterListContainer = document.createElement('div');
            chapterListContainer.classList.add('chapter-list-container');
            chapterListContainer.style.display = 'none'; // Initially hidden
            bookContainer.appendChild(chapterListContainer);

            bookList.appendChild(bookContainer);
        });
        if (books.length > 0) {
            // Automatically load the first book's chapters into the player on startup
            await loadChapters(books[0]);
            // Expand the first book in the browser view
            const firstBookContainer = bookList.querySelector('.book-container');
            if (firstBookContainer) {
                firstBookContainer.querySelector('.book-item').classList.add('active');
                const chapterListContainer = firstBookContainer.querySelector('.chapter-list-container');
                chapterListContainer.style.display = 'block';
                renderBookChaptersInBrowser(books[0], chapterListContainer);
            }
            loadCharacters(books[0]);
        }
    } catch (error) {
        alert(`Error loading audiobooks: ${error.message}`);
    }
}


// Settings Modal Functionality
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsCloseButton = document.getElementById('settings-close-button');
const geminiApiKeyInput = document.getElementById('gemini-api-key-input');
const toggleApiKeyVisibility = document.getElementById('toggle-api-key-visibility');
const testApiKeyBtn = document.getElementById('test-api-key-btn');
const saveApiKeyBtn = document.getElementById('save-api-key-btn');
const apiKeyStatus = document.getElementById('api-key-status');

// HuggingFace token elements
const hfTokenInput = document.getElementById('hf-token-input');
const toggleHfTokenVisibility = document.getElementById('toggle-hf-token-visibility');
const saveHfTokenBtn = document.getElementById('save-hf-token-btn');
const hfTokenStatus = document.getElementById('hf-token-status');

// Open settings modal
settingsBtn.addEventListener('click', async () => {
    settingsModal.style.display = 'block';
    
    // Check current API key status
    const status = await ipcRenderer.invoke('get-api-key-status');
    if (status.hasKey) {
        geminiApiKeyInput.placeholder = 'API key is configured (hidden for security)';
        showStatus('API key is configured and ready to use.', 'success');
    } else {
        showStatus('No API key configured. Please enter your Gemini API key.', 'error');
    }
    
    if (!status.encryptionAvailable) {
        showStatus('Warning: Secure storage not available on this system. API key will be stored as plain text.', 'error');
    }
    
    // Check HuggingFace token status
    const hfStatus = await ipcRenderer.invoke('get-hf-token-status');
    if (hfStatus.hasToken) {
        hfTokenInput.placeholder = 'Token is configured (hidden for security)';
        showHfStatus('HuggingFace token is configured.', 'success');
    } else {
        showHfStatus('Optional: Add token for Kontext model downloads.', 'info');
    }
    
    // Load prompts
    await loadPrompts();
    
    // Load tags
    await loadTags();
    
    // Load storyboard tags
    await loadStoryboardTags();
    
    // Load story context
    await loadStoryContext();
    
    // Load ComfyUI path
    const comfyPath = await ipcRenderer.invoke('comfyui-get-path');
    if (comfyPath) {
        comfyUIPathInput.value = comfyPath;
    }
    
    // Load current generation service
    const currentService = await ipcRenderer.invoke('get-generation-service');
    if (currentService === 'runpod') {
        serviceRunpodRadio.checked = true;
        localServiceSettings.style.display = 'none';
        runpodServiceSettings.style.display = 'block';
        runpodCostInfo.style.display = 'block';
    } else {
        serviceLocalRadio.checked = true;
        localServiceSettings.style.display = 'block';
        runpodServiceSettings.style.display = 'none';
    }
    
    // Check RunPod API key status
    const runpodStatus = await ipcRenderer.invoke('get-runpod-status');
    if (runpodStatus.hasKey) {
        runpodApiKeyInput.placeholder = 'API key is configured (hidden for security)';
        showRunpodStatus('RunPod API key is configured.', 'success');
    }
});

// Close settings modal
settingsCloseButton.addEventListener('click', () => {
    settingsModal.style.display = 'none';
    geminiApiKeyInput.value = '';
    hfTokenInput.value = '';
    hideStatus();
    hideHfStatus();
});

// Toggle API key visibility
toggleApiKeyVisibility.addEventListener('click', () => {
    if (geminiApiKeyInput.type === 'password') {
        geminiApiKeyInput.type = 'text';
        toggleApiKeyVisibility.textContent = '🙈';
    } else {
        geminiApiKeyInput.type = 'password';
        toggleApiKeyVisibility.textContent = '👁️';
    }
});

// Test API key
testApiKeyBtn.addEventListener('click', async () => {
    const apiKey = geminiApiKeyInput.value.trim();
    if (!apiKey) {
        showStatus('Please enter an API key to test.', 'error');
        return;
    }
    
    showStatus('Testing API key...', 'success');
    testApiKeyBtn.disabled = true;
    
    try {
        const result = await ipcRenderer.invoke('test-api-key', apiKey);
        if (result.success && result.working) {
            showStatus('✅ API key is valid and working!', 'success');
        } else if (result.success && !result.working) {
            showStatus('⚠️ API key appears valid but test response was unexpected.', 'error');
        } else {
            showStatus(`❌ API key test failed: ${result.error}`, 'error');
        }
    } catch (error) {
        showStatus(`❌ Error testing API key: ${error.message}`, 'error');
    } finally {
        testApiKeyBtn.disabled = false;
    }
});

// Save API key
saveApiKeyBtn.addEventListener('click', async () => {
    const apiKey = geminiApiKeyInput.value.trim();
    if (!apiKey) {
        showStatus('Please enter an API key to save.', 'error');
        return;
    }
    
    showStatus('Saving API key...', 'success');
    saveApiKeyBtn.disabled = true;
    
    try {
        const result = await ipcRenderer.invoke('save-api-key', apiKey);
        if (result.success) {
            showStatus('✅ API key saved successfully!', 'success');
            geminiApiKeyInput.value = '';
            geminiApiKeyInput.placeholder = 'API key is configured (hidden for security)';
        } else {
            showStatus(`❌ Failed to save API key: ${result.error}`, 'error');
        }
    } catch (error) {
        showStatus(`❌ Error saving API key: ${error.message}`, 'error');
    } finally {
        saveApiKeyBtn.disabled = false;
    }
});

// Helper functions for status messages
function showStatus(message, type) {
    apiKeyStatus.textContent = message;
    apiKeyStatus.className = `status-message ${type}`;
}

function hideStatus() {
    apiKeyStatus.style.display = 'none';
    apiKeyStatus.className = 'status-message';
}

function showHfStatus(message, type) {
    hfTokenStatus.textContent = message;
    hfTokenStatus.className = `status-message ${type}`;
}

function hideHfStatus() {
    hfTokenStatus.style.display = 'none';
    hfTokenStatus.className = 'status-message';
}

// Toggle HuggingFace token visibility
toggleHfTokenVisibility.addEventListener('click', () => {
    if (hfTokenInput.type === 'password') {
        hfTokenInput.type = 'text';
        toggleHfTokenVisibility.textContent = '🙈';
    } else {
        hfTokenInput.type = 'password';
        toggleHfTokenVisibility.textContent = '👁️';
    }
});

// Save HuggingFace token
saveHfTokenBtn.addEventListener('click', async () => {
    const token = hfTokenInput.value.trim();
    if (!token) {
        showHfStatus('Please enter a token to save.', 'error');
        return;
    }
    
    showHfStatus('Saving token...', 'success');
    saveHfTokenBtn.disabled = true;
    
    try {
        const result = await ipcRenderer.invoke('save-hf-token', token);
        if (result.success) {
            showHfStatus('✅ Token saved successfully!', 'success');
            hfTokenInput.value = '';
            hfTokenInput.placeholder = 'Token is configured (hidden for security)';
        } else {
            showHfStatus(`❌ Failed to save token: ${result.error}`, 'error');
        }
    } catch (error) {
        showHfStatus(`❌ Error saving token: ${error.message}`, 'error');
    } finally {
        saveHfTokenBtn.disabled = false;
    }
});

// Service selector elements
const serviceLocalRadio = document.getElementById('service-local');
const serviceRunpodRadio = document.getElementById('service-runpod');
const localServiceSettings = document.getElementById('local-service-settings');
const runpodServiceSettings = document.getElementById('runpod-service-settings');

// RunPod elements
const runpodApiKeyInput = document.getElementById('runpod-api-key-input');
const runpodEndpointIdInput = document.getElementById('runpod-endpoint-id-input');
const toggleRunpodKeyVisibility = document.getElementById('toggle-runpod-key-visibility');
const testRunpodBtn = document.getElementById('test-runpod-btn');
const saveRunpodKeyBtn = document.getElementById('save-runpod-key-btn');
const runpodEndpointStatus = document.getElementById('runpod-endpoint-status');
const runpodCostInfo = document.getElementById('runpod-cost-info');

// ComfyUI Settings Elements
const comfyUIPathInput = document.getElementById('comfyui-path-input');
const browseComfyUIPathBtn = document.getElementById('browse-comfyui-path');
const validateComfyuiBtn = document.getElementById('validate-comfyui-btn');
const saveComfyuiPathBtn = document.getElementById('save-comfyui-path-btn');
const comfyuiValidationStatus = document.getElementById('comfyui-validation-status');
const comfyuiRequirements = document.getElementById('comfyui-requirements');

// Set up ComfyUI event listeners only if elements exist
if (browseComfyUIPathBtn) {
    // Browse for ComfyUI path
    browseComfyUIPathBtn.addEventListener('click', async () => {
        const result = await ipcRenderer.invoke('dialog-select-directory');
        if (result && !result.canceled && result.filePaths.length > 0) {
            comfyUIPathInput.value = result.filePaths[0];
        }
    });
}

if (validateComfyuiBtn) {
    // Validate ComfyUI installation
    validateComfyuiBtn.addEventListener('click', async () => {
        const path = comfyUIPathInput.value.trim();
        if (!path) {
            showComfyUIStatus('Please enter the ComfyUI installation path.', 'error');
            return;
        }
        
        showComfyUIStatus('Validating installation...', 'info');
        validateComfyuiBtn.disabled = true;
        
        try {
            const result = await ipcRenderer.invoke('comfyui-validate-installation');
            if (result.valid) {
                let status = '✅ Valid ComfyUI installation found!';
                if (!result.hasFluxKontext) {
                    status += '\n⚠️ FLUX Kontext nodes not found. Please install them for full functionality.';
                    comfyuiRequirements.style.display = 'block';
                } else {
                    comfyuiRequirements.style.display = 'none';
                }
                showComfyUIStatus(status, result.hasFluxKontext ? 'success' : 'warning');
            } else {
                showComfyUIStatus(`❌ Invalid installation: ${result.error}`, 'error');
                comfyuiRequirements.style.display = 'block';
            }
        } catch (error) {
            showComfyUIStatus(`❌ Error validating: ${error.message}`, 'error');
        } finally {
            validateComfyuiBtn.disabled = false;
        }
    });
}

if (saveComfyuiPathBtn) {
    // Save ComfyUI path
    saveComfyuiPathBtn.addEventListener('click', async () => {
        const path = comfyUIPathInput.value.trim();
        if (!path) {
            showComfyUIStatus('Please enter the ComfyUI installation path.', 'error');
            return;
        }
        
        showComfyUIStatus('Saving path...', 'info');
        saveComfyuiPathBtn.disabled = true;
        
        try {
            const result = await ipcRenderer.invoke('comfyui-set-path', path);
            if (result.success) {
                showComfyUIStatus('✅ ComfyUI path saved successfully!', 'success');
                if (result.validation && !result.validation.hasFluxKontext) {
                    comfyuiRequirements.style.display = 'block';
                }
                // Update FLUX service status
                await checkFluxServiceStatus();
            } else {
                showComfyUIStatus(`❌ Failed to save path: ${result.error}`, 'error');
            }
        } catch (error) {
            showComfyUIStatus(`❌ Error saving path: ${error.message}`, 'error');
        } finally {
            saveComfyuiPathBtn.disabled = false;
        }
    });
}

// Helper function for ComfyUI status messages
function showComfyUIStatus(message, type) {
    comfyuiValidationStatus.textContent = message;
    comfyuiValidationStatus.className = `status-message ${type}`;
    comfyuiValidationStatus.style.display = 'block';
}

// Service selector event listeners
serviceLocalRadio.addEventListener('change', () => {
    if (serviceLocalRadio.checked) {
        localServiceSettings.style.display = 'block';
        runpodServiceSettings.style.display = 'none';
        ipcRenderer.invoke('set-generation-service', 'local');
    }
});

serviceRunpodRadio.addEventListener('change', () => {
    if (serviceRunpodRadio.checked) {
        localServiceSettings.style.display = 'none';
        runpodServiceSettings.style.display = 'block';
        runpodCostInfo.style.display = 'block';
        ipcRenderer.invoke('set-generation-service', 'runpod');
    }
});

// RunPod API key visibility toggle
toggleRunpodKeyVisibility.addEventListener('click', () => {
    if (runpodApiKeyInput.type === 'password') {
        runpodApiKeyInput.type = 'text';
        toggleRunpodKeyVisibility.textContent = '🙈';
    } else {
        runpodApiKeyInput.type = 'password';
        toggleRunpodKeyVisibility.textContent = '👁️';
    }
});

// Test RunPod connection
testRunpodBtn.addEventListener('click', async () => {
    const apiKey = runpodApiKeyInput.value.trim();
    const endpointId = runpodEndpointIdInput.value.trim();
    
    if (!apiKey) {
        showRunpodStatus('Please enter an API key to test.', 'error');
        return;
    }
    
    showRunpodStatus('Testing RunPod connection...', 'info');
    testRunpodBtn.disabled = true;
    
    try {
        const result = await ipcRenderer.invoke('test-runpod-connection', { apiKey, endpointId });
        if (result.success) {
            showRunpodStatus('✅ RunPod connection successful!', 'success');
        } else {
            showRunpodStatus(`❌ Connection failed: ${result.error}`, 'error');
        }
    } catch (error) {
        showRunpodStatus(`❌ Error testing connection: ${error.message}`, 'error');
    } finally {
        testRunpodBtn.disabled = false;
    }
});

// Save RunPod API key
saveRunpodKeyBtn.addEventListener('click', async () => {
    const apiKey = runpodApiKeyInput.value.trim();
    const endpointId = runpodEndpointIdInput.value.trim();
    
    if (!apiKey) {
        showRunpodStatus('Please enter an API key to save.', 'error');
        return;
    }
    
    showRunpodStatus('Saving RunPod configuration...', 'info');
    saveRunpodKeyBtn.disabled = true;
    
    try {
        const result = await ipcRenderer.invoke('save-runpod-key', { apiKey, endpointId });
        if (result.success) {
            showRunpodStatus('✅ RunPod configuration saved successfully!', 'success');
            runpodApiKeyInput.value = '';
            runpodApiKeyInput.placeholder = 'API key is configured (hidden for security)';
            if (endpointId) {
                runpodEndpointIdInput.placeholder = 'Endpoint ID is configured';
            }
        } else {
            showRunpodStatus(`❌ Failed to save configuration: ${result.error}`, 'error');
        }
    } catch (error) {
        showRunpodStatus(`❌ Error saving configuration: ${error.message}`, 'error');
    } finally {
        saveRunpodKeyBtn.disabled = false;
    }
});

// Helper function for RunPod status messages
function showRunpodStatus(message, type) {
    runpodEndpointStatus.textContent = message;
    runpodEndpointStatus.className = `status-message ${type}`;
    runpodEndpointStatus.style.display = 'block';
}

// Prompt Settings Elements
const characterIdentificationPrompt = document.getElementById('character-identification-prompt');
const physicalDescriptionPrompt = document.getElementById('physical-description-prompt');
const characterEvolutionPrompt = document.getElementById('character-evolution-prompt');
const descriptionDetailPrompt = document.getElementById('description-detail-prompt');
const resetPromptsBtn = document.getElementById('reset-prompts-btn');
const savePromptsBtn = document.getElementById('save-prompts-btn');
const promptsStatus = document.getElementById('prompts-status');

// Default prompts
const defaultPrompts = {
    characterIdentification: `Use advanced reasoning to identify when different names/titles refer to the same person
Examples: "Didius Falco" = "Falco", "the young prince" = "Prince Adrian" = "Adrian"
Merge all references into a single character entry using the most complete/formal name`,
    
    physicalDescription: `Extract ALL physical details mentioned about each character FROM HEAD TO TOE
CRITICAL: Always describe the complete person for full body portraits:
- HEAD/HAIR: Hair color, style, length, texture, any head coverings, hair accessories
- FACE: Eyes, nose, mouth, skin tone, facial hair, distinguishing features
- BODY: Build, height, posture, skin marks, tattoos, scars
- CLOTHING: Every layer from top to bottom, colors, materials, condition
- FEET/FOOTWEAR: ALWAYS include footwear details (boots, sandals, shoes, bare feet, etc.)
If feet/footwear not mentioned in text, note "footwear not specified" but suggest appropriate footwear for the character's status/setting
Note when new details are revealed (e.g., a birthmark mentioned for the first time in chapter 5)`,
    
    characterEvolution: `Identify when a character's appearance changes significantly
Create sub-characteristics for major transformations:
* Age progression (young prince → middle-aged king → elderly ruler)
* Status changes affecting appearance (peasant → knight → lord)
* Physical changes (injuries, scars, weight changes, hair changes)
* Costume/role changes (disguises, different outfits for different scenes)`,
    
    descriptionDetail: `Make descriptions vivid and specific FOR FULL BODY PORTRAITS
For baseDescription: Include chapter references and detailed analysis from head to toe
For imagePrompt: Create clean COMPLETE head-to-toe visual descriptions without chapter refs
CRITICAL for imagePrompt:
- Start with age, gender, overall build
- Describe head/hair in detail (color, style, length, accessories)
- Include all facial features
- Describe complete outfit from top to bottom
- ALWAYS end with footwear (even if you must infer appropriate footwear)
Example: "tall man, approximately 6'2", broad shoulders, athletic build" → "tall man, 6'2", broad shoulders, athletic build, short dark hair, brown eyes, weathered face with realistic wrinkles, black tunic, leather belt, dark trousers, worn leather boots"
The goal is a COMPLETE person that AI can generate as a full body portrait
IMPORTANT: Describe realistic human proportions and features, avoid exaggerated features`
};

// Load saved prompts or use defaults
async function loadPrompts() {
    try {
        const bookIndicator = document.getElementById('current-book-indicator');
        
        if (!currentBook) {
            resetPromptsToDefaults();
            bookIndicator.textContent = 'No book selected. Default prompts will be used.';
            return;
        }
        
        bookIndicator.textContent = `Editing prompts for: ${currentBook}`;
        
        const bookPath = path.join(audiobooksDir, currentBook);
        const savedPrompts = await ipcRenderer.invoke('get-prompts', bookPath);
        
        if (savedPrompts && savedPrompts.success) {
            characterIdentificationPrompt.value = savedPrompts.prompts.characterIdentification || defaultPrompts.characterIdentification;
            physicalDescriptionPrompt.value = savedPrompts.prompts.physicalDescription || defaultPrompts.physicalDescription;
            characterEvolutionPrompt.value = savedPrompts.prompts.characterEvolution || defaultPrompts.characterEvolution;
            descriptionDetailPrompt.value = savedPrompts.prompts.descriptionDetail || defaultPrompts.descriptionDetail;
        } else {
            // Load defaults
            resetPromptsToDefaults();
        }
    } catch (error) {
        console.error('Error loading prompts:', error);
        resetPromptsToDefaults();
    }
}

// Reset prompts to defaults
function resetPromptsToDefaults() {
    characterIdentificationPrompt.value = defaultPrompts.characterIdentification;
    physicalDescriptionPrompt.value = defaultPrompts.physicalDescription;
    characterEvolutionPrompt.value = defaultPrompts.characterEvolution;
    descriptionDetailPrompt.value = defaultPrompts.descriptionDetail;
}

// Reset prompts button handler
resetPromptsBtn.addEventListener('click', () => {
    resetPromptsToDefaults();
    showPromptsStatus('Prompts reset to defaults', 'success');
});

// Save prompts button handler
savePromptsBtn.addEventListener('click', async () => {
    if (!currentBook) {
        showPromptsStatus('❌ No book selected. Please select a book first.', 'error');
        return;
    }
    
    const prompts = {
        characterIdentification: characterIdentificationPrompt.value.trim(),
        physicalDescription: physicalDescriptionPrompt.value.trim(),
        characterEvolution: characterEvolutionPrompt.value.trim(),
        descriptionDetail: descriptionDetailPrompt.value.trim()
    };
    
    showPromptsStatus('Saving prompts...', 'success');
    savePromptsBtn.disabled = true;
    
    try {
        const bookPath = path.join(audiobooksDir, currentBook);
        const result = await ipcRenderer.invoke('save-prompts', { bookPath, prompts });
        if (result.success) {
            showPromptsStatus(`✅ Prompts saved for "${currentBook}"!`, 'success');
        } else {
            showPromptsStatus(`❌ Failed to save prompts: ${result.error}`, 'error');
        }
    } catch (error) {
        showPromptsStatus(`❌ Error saving prompts: ${error.message}`, 'error');
    } finally {
        savePromptsBtn.disabled = false;
    }
});

// Helper function for prompts status
function showPromptsStatus(message, type) {
    promptsStatus.textContent = message;
    promptsStatus.className = `status-message ${type}`;
    promptsStatus.style.display = 'block';
    
    // Auto-hide success messages after 3 seconds
    if (type === 'success') {
        setTimeout(() => {
            promptsStatus.style.display = 'none';
        }, 3000);
    }
}

// Tags Management
const globalTagsList = document.getElementById('global-tags-list');
const newTagInput = document.getElementById('new-tag-input');
const addTagBtn = document.getElementById('add-tag-btn');
const resetTagsBtn = document.getElementById('reset-tags-btn');
const saveTagsBtn = document.getElementById('save-tags-btn');
const tagsStatus = document.getElementById('tags-status');
const bookTagsIndicator = document.getElementById('current-book-tags-indicator');

// Default tags
const defaultTags = [
    'Solid White Background', 
    'Photorealistic',
    'Ultra realistic photography',
    'Professional photography', 
    'Real human',
    'Natural skin texture',
    'Full Body Portrait',
    'NOT anime',
    'NOT cartoon',
    'NOT illustration'
];

// Current tags state
let currentGlobalTags = [...defaultTags];
let characterTags = {}; // Map of character name to their tags

// Render tags in the UI
function renderGlobalTags() {
    globalTagsList.innerHTML = '';
    currentGlobalTags.forEach((tag, index) => {
        const tagElement = document.createElement('div');
        tagElement.className = 'tag';
        tagElement.innerHTML = `
            ${tag}
            <span class="tag-remove" data-index="${index}">×</span>
        `;
        globalTagsList.appendChild(tagElement);
    });
    
    // Add click handlers for remove buttons
    globalTagsList.querySelectorAll('.tag-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.index);
            currentGlobalTags.splice(index, 1);
            renderGlobalTags();
        });
    });
}

// Add new tag
addTagBtn.addEventListener('click', () => {
    const newTag = newTagInput.value.trim();
    if (newTag && !currentGlobalTags.includes(newTag)) {
        currentGlobalTags.push(newTag);
        renderGlobalTags();
        newTagInput.value = '';
    }
});

// Allow Enter key to add tag
newTagInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        addTagBtn.click();
    }
});

// Reset tags to defaults
resetTagsBtn.addEventListener('click', () => {
    currentGlobalTags = [...defaultTags];
    renderGlobalTags();
    showTagsStatus('Tags reset to defaults', 'success');
});

// Save tags
saveTagsBtn.addEventListener('click', async () => {
    if (!currentBook) {
        showTagsStatus('❌ No book selected. Please select a book first.', 'error');
        return;
    }
    
    showTagsStatus('Saving tags...', 'success');
    saveTagsBtn.disabled = true;
    
    try {
        const bookPath = path.join(audiobooksDir, currentBook);
        const tagsData = {
            globalTags: currentGlobalTags,
            characterTags: characterTags
        };
        
        const result = await ipcRenderer.invoke('save-tags', { bookPath, tags: tagsData });
        if (result.success) {
            showTagsStatus(`✅ Tags saved for "${currentBook}"!`, 'success');
        } else {
            showTagsStatus(`❌ Failed to save tags: ${result.error}`, 'error');
        }
    } catch (error) {
        showTagsStatus(`❌ Error saving tags: ${error.message}`, 'error');
    } finally {
        saveTagsBtn.disabled = false;
    }
});

// Load tags
async function loadTags() {
    try {
        if (!currentBook) {
            currentGlobalTags = [...defaultTags];
            characterTags = {};
            renderGlobalTags();
            bookTagsIndicator.textContent = 'No book selected. Default tags will be used.';
            return;
        }
        
        bookTagsIndicator.textContent = `Tags for: ${currentBook}`;
        
        const bookPath = path.join(audiobooksDir, currentBook);
        const savedTags = await ipcRenderer.invoke('get-tags', bookPath);
        
        if (savedTags && savedTags.success) {
            currentGlobalTags = savedTags.tags.globalTags || [...defaultTags];
            characterTags = savedTags.tags.characterTags || {};
        } else {
            currentGlobalTags = [...defaultTags];
            characterTags = {};
        }
        
        renderGlobalTags();
    } catch (error) {
        console.error('Error loading tags:', error);
        currentGlobalTags = [...defaultTags];
        characterTags = {};
        renderGlobalTags();
    }
}

// Helper function for tags status
function showTagsStatus(message, type) {
    tagsStatus.textContent = message;
    tagsStatus.className = `status-message ${type}`;
    tagsStatus.style.display = 'block';
    
    // Auto-hide success messages after 3 seconds
    if (type === 'success') {
        setTimeout(() => {
            tagsStatus.style.display = 'none';
        }, 3000);
    }
}

// Story Board Tags Management
const storyboardTagsList = document.getElementById('storyboard-tags-list');
const newStoryboardTagInput = document.getElementById('new-storyboard-tag-input');
const addStoryboardTagBtn = document.getElementById('add-storyboard-tag-btn');
const resetStoryboardTagsBtn = document.getElementById('reset-storyboard-tags-btn');
const saveStoryboardTagsBtn = document.getElementById('save-storyboard-tags-btn');
const storyboardTagsStatus = document.getElementById('storyboard-tags-status');
const bookStoryboardTagsIndicator = document.getElementById('current-book-storyboard-tags-indicator');

// Default story board tags
const defaultStoryboardTags = [
    'cinematic',
    'photorealistic',
    'dramatic lighting',
    'epic composition',
    'movie still',
    'professional cinematography'
];

// Current story board tags state
let currentStoryboardTags = [...defaultStoryboardTags];

// Render story board tags
function renderStoryboardTags() {
    storyboardTagsList.innerHTML = '';
    currentStoryboardTags.forEach((tag, index) => {
        const tagElement = document.createElement('div');
        tagElement.classList.add('tag');
        tagElement.innerHTML = `
            <span>${tag}</span>
            <button class="remove-tag" data-index="${index}">×</button>
        `;
        storyboardTagsList.appendChild(tagElement);
    });
    
    // Add event listeners to remove buttons
    document.querySelectorAll('#storyboard-tags-list .remove-tag').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.index);
            currentStoryboardTags.splice(index, 1);
            renderStoryboardTags();
        });
    });
}

// Add new story board tag
addStoryboardTagBtn.addEventListener('click', () => {
    const newTag = newStoryboardTagInput.value.trim();
    if (newTag && !currentStoryboardTags.includes(newTag)) {
        currentStoryboardTags.push(newTag);
        renderStoryboardTags();
        newStoryboardTagInput.value = '';
    }
});

// Enter key to add tag
newStoryboardTagInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        addStoryboardTagBtn.click();
    }
});

// Reset to default story board tags
resetStoryboardTagsBtn.addEventListener('click', () => {
    currentStoryboardTags = [...defaultStoryboardTags];
    renderStoryboardTags();
    showStoryboardTagsStatus('Tags reset to defaults', 'success');
});

// Save story board tags
saveStoryboardTagsBtn.addEventListener('click', async () => {
    if (!currentBook) {
        showStoryboardTagsStatus('Please select a book first', 'error');
        return;
    }
    
    try {
        const result = await ipcRenderer.invoke('save-storyboard-tags', currentBook, currentStoryboardTags);
        if (result.success) {
            showStoryboardTagsStatus('Story board tags saved successfully!', 'success');
        } else {
            showStoryboardTagsStatus('Failed to save tags', 'error');
        }
    } catch (error) {
        console.error('Error saving story board tags:', error);
        showStoryboardTagsStatus('Error saving tags', 'error');
    }
});

// Load story board tags for current book
async function loadStoryboardTags() {
    try {
        if (!currentBook) {
            currentStoryboardTags = [...defaultStoryboardTags];
            renderStoryboardTags();
            bookStoryboardTagsIndicator.textContent = 'No book selected. Default tags will be used.';
            return;
        }
        
        bookStoryboardTagsIndicator.textContent = `Story board tags for: ${currentBook}`;
        
        const savedTags = await ipcRenderer.invoke('get-storyboard-tags', currentBook);
        
        if (savedTags && savedTags.success && savedTags.tags) {
            currentStoryboardTags = savedTags.tags;
        } else {
            currentStoryboardTags = [...defaultStoryboardTags];
        }
        
        renderStoryboardTags();
    } catch (error) {
        console.error('Error loading story board tags:', error);
        currentStoryboardTags = [...defaultStoryboardTags];
        renderStoryboardTags();
    }
}

// Helper function for story board tags status
function showStoryboardTagsStatus(message, type) {
    storyboardTagsStatus.textContent = message;
    storyboardTagsStatus.className = `status-message ${type}`;
    storyboardTagsStatus.style.display = 'block';
    
    // Auto-hide success messages after 3 seconds
    if (type === 'success') {
        setTimeout(() => {
            storyboardTagsStatus.style.display = 'none';
        }, 3000);
    }
}


// Story Context Management
const storyTimePeriodInput = document.getElementById('story-time-period');
const storyLocationInput = document.getElementById('story-location');
const saveContextBtn = document.getElementById('save-context-btn');
const contextStatus = document.getElementById('context-status');
const bookContextIndicator = document.getElementById('current-book-context-indicator');

// Current story context state
let currentStoryContext = {
    timePeriod: '',
    location: ''
};

// Save story context
saveContextBtn.addEventListener('click', async () => {
    if (!currentBook) {
        showContextStatus('Please select a book first', 'error');
        return;
    }
    
    currentStoryContext.timePeriod = storyTimePeriodInput.value.trim();
    currentStoryContext.location = storyLocationInput.value.trim();
    
    try {
        const result = await ipcRenderer.invoke('save-story-context', currentBook, currentStoryContext);
        if (result.success) {
            showContextStatus('Story context saved successfully!', 'success');
        } else {
            showContextStatus('Failed to save context', 'error');
        }
    } catch (error) {
        console.error('Error saving story context:', error);
        showContextStatus('Error saving context', 'error');
    }
});

// Load story context for current book
async function loadStoryContext() {
    try {
        if (!currentBook) {
            currentStoryContext = { timePeriod: '', location: '' };
            storyTimePeriodInput.value = '';
            storyLocationInput.value = '';
            bookContextIndicator.textContent = 'No book selected.';
            return;
        }
        
        bookContextIndicator.textContent = `Context for: ${currentBook}`;
        
        const savedContext = await ipcRenderer.invoke('get-story-context', currentBook);
        
        if (savedContext && savedContext.success && savedContext.context) {
            currentStoryContext = savedContext.context;
            storyTimePeriodInput.value = currentStoryContext.timePeriod || '';
            storyLocationInput.value = currentStoryContext.location || '';
        } else {
            currentStoryContext = { timePeriod: '', location: '' };
            storyTimePeriodInput.value = '';
            storyLocationInput.value = '';
        }
    } catch (error) {
        console.error('Error loading story context:', error);
        currentStoryContext = { timePeriod: '', location: '' };
        storyTimePeriodInput.value = '';
        storyLocationInput.value = '';
    }
}

// Helper function for context status
function showContextStatus(message, type) {
    contextStatus.textContent = message;
    contextStatus.className = `status-message ${type}`;
    contextStatus.style.display = 'block';
    
    // Auto-hide success messages after 3 seconds
    if (type === 'success') {
        setTimeout(() => {
            contextStatus.style.display = 'none';
        }, 3000);
    }
}

// Close modal when clicking outside
window.addEventListener('click', (event) => {
    if (event.target === settingsModal) {
        settingsModal.style.display = 'none';
        geminiApiKeyInput.value = '';
        hideStatus();
    }
});

// Regenerate Character Modal
const regenerateModal = document.getElementById('regenerate-character-modal');
const regenerateCloseBtn = document.getElementById('regenerate-close-button');
const regenerateCharacterNameEl = document.getElementById('regenerate-character-name');
const chapterCheckboxesContainer = document.getElementById('chapter-checkboxes');
const selectAllChaptersBtn = document.getElementById('select-all-chapters');
const deselectAllChaptersBtn = document.getElementById('deselect-all-chapters');
const rangeStartInput = document.getElementById('range-start');
const rangeEndInput = document.getElementById('range-end');
const applyRangeBtn = document.getElementById('apply-range');
const regenerateCharacterBtn = document.getElementById('regenerate-character-btn');
const cancelRegenerateBtn = document.getElementById('cancel-regenerate-btn');
const regenerateStatus = document.getElementById('regenerate-status');

let currentCharacterForRegenerate = null;
let availableChapters = [];

function openRegenerateModal(character) {
    currentCharacterForRegenerate = character;
    regenerateCharacterNameEl.textContent = `Character: ${character.name}`;
    regenerateModal.style.display = 'block';
    
    // Load available chapters
    loadAvailableChapters();
}

async function loadAvailableChapters() {
    chapterCheckboxesContainer.innerHTML = '';
    availableChapters = [];
    
    const bookDir = path.join(audiobooksDir, currentBook);
    const files = fs.readdirSync(bookDir);
    
    // Get all .txt files (transcripts)
    const transcriptFiles = files.filter(file => file.endsWith('.txt') && !file.includes('characters'));
    
    // Sort chapters numerically if they follow a pattern
    transcriptFiles.sort((a, b) => {
        const aMatch = a.match(/chapter[_\s]*(\d+)/i);
        const bMatch = b.match(/chapter[_\s]*(\d+)/i);
        if (aMatch && bMatch) {
            return parseInt(aMatch[1]) - parseInt(bMatch[1]);
        }
        return a.localeCompare(b);
    });
    
    transcriptFiles.forEach((file, index) => {
        const chapterName = file.replace('.txt', '');
        const chapterNum = index + 1;
        
        availableChapters.push({
            file: file,
            name: chapterName,
            number: chapterNum,
            path: path.join(bookDir, file)
        });
        
        // Create checkbox
        const checkboxItem = document.createElement('div');
        checkboxItem.className = 'chapter-checkbox-item';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `chapter-${chapterNum}`;
        checkbox.value = chapterNum;
        
        const label = document.createElement('label');
        label.htmlFor = `chapter-${chapterNum}`;
        label.textContent = `${chapterNum}. ${chapterName}`;
        
        checkboxItem.appendChild(checkbox);
        checkboxItem.appendChild(label);
        chapterCheckboxesContainer.appendChild(checkboxItem);
    });
    
    // Update range inputs max values
    rangeStartInput.max = availableChapters.length;
    rangeEndInput.max = availableChapters.length;
}

// Select all chapters
selectAllChaptersBtn.addEventListener('click', () => {
    const checkboxes = chapterCheckboxesContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
});

// Deselect all chapters
deselectAllChaptersBtn.addEventListener('click', () => {
    const checkboxes = chapterCheckboxesContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
});

// Apply range selection
applyRangeBtn.addEventListener('click', () => {
    const start = parseInt(rangeStartInput.value);
    const end = parseInt(rangeEndInput.value);
    
    if (start && end && start <= end) {
        const checkboxes = chapterCheckboxesContainer.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => {
            const chapterNum = parseInt(cb.value);
            cb.checked = chapterNum >= start && chapterNum <= end;
        });
    }
});

// Regenerate character description
regenerateCharacterBtn.addEventListener('click', async () => {
    const selectedChapters = [];
    const checkboxes = chapterCheckboxesContainer.querySelectorAll('input[type="checkbox"]:checked');
    
    if (checkboxes.length === 0) {
        showRegenerateStatus('Please select at least one chapter', 'error');
        return;
    }
    
    checkboxes.forEach(cb => {
        const chapterNum = parseInt(cb.value);
        selectedChapters.push(availableChapters[chapterNum - 1]);
    });
    
    await regenerateCharacterDescription(currentCharacterForRegenerate, selectedChapters);
});

async function regenerateCharacterDescription(character, selectedChapters) {
    showRegenerateStatus('Regenerating character description...', 'info');
    regenerateCharacterBtn.disabled = true;
    
    try {
        // Combine transcripts from selected chapters
        let combinedTranscript = '';
        for (const chapter of selectedChapters) {
            const transcript = fs.readFileSync(chapter.path, 'utf-8');
            combinedTranscript += `\n\n--- Chapter ${chapter.number}: ${chapter.name} ---\n${transcript}`;
        }
        
        const bookPath = path.join(audiobooksDir, currentBook);
        
        // Get current characters to maintain the list
        const charactersJsonPath = getCharactersFilePath(currentBook);
        let allCharacters = [];
        if (fs.existsSync(charactersJsonPath)) {
            allCharacters = JSON.parse(fs.readFileSync(charactersJsonPath, 'utf-8'));
        }
        
        // Call Gemini to regenerate just this character
        const result = await ipcRenderer.invoke('regenerate-character-description', {
            characterName: character.name,
            transcript: combinedTranscript,
            selectedChapters: selectedChapters.map(ch => ch.number),
            bookPath: bookPath
        });
        
        if (result.error) {
            throw new Error(result.error);
        }
        
        // Update the character in the list
        const charIndex = allCharacters.findIndex(c => c.name === character.name);
        if (charIndex !== -1 && result.character) {
            // Preserve the photo path if it exists
            if (allCharacters[charIndex].photo && allCharacters[charIndex].photo !== 'placeholder.png') {
                result.character.photo = allCharacters[charIndex].photo;
            }
            
            // Preserve sub-characteristic photos
            if (result.character.subCharacteristics && allCharacters[charIndex].subCharacteristics) {
                result.character.subCharacteristics.forEach(newSub => {
                    const oldSub = allCharacters[charIndex].subCharacteristics.find(s => s.id === newSub.id);
                    if (oldSub && oldSub.photo && oldSub.photo !== 'placeholder.png') {
                        newSub.photo = oldSub.photo;
                    }
                });
            }
            
            allCharacters[charIndex] = result.character;
            
            // Save updated characters
            fs.writeFileSync(charactersJsonPath, JSON.stringify(allCharacters, null, 2));
            
            showRegenerateStatus('✅ Character description regenerated successfully!', 'success');
            
            // Reload characters display
            await loadCharacters(currentBook);
            
            // Close modal after success
            setTimeout(() => {
                regenerateModal.style.display = 'none';
                resetRegenerateModal();
            }, 1500);
        } else {
            throw new Error('Character not found in the list');
        }
    } catch (error) {
        console.error('Error regenerating character:', error);
        showRegenerateStatus(`❌ Error: ${error.message}`, 'error');
    } finally {
        regenerateCharacterBtn.disabled = false;
    }
}

function showRegenerateStatus(message, type) {
    regenerateStatus.textContent = message;
    regenerateStatus.className = `status-message ${type}`;
    regenerateStatus.style.display = 'block';
    
    if (type === 'success') {
        setTimeout(() => {
            regenerateStatus.style.display = 'none';
        }, 3000);
    }
}

function resetRegenerateModal() {
    currentCharacterForRegenerate = null;
    chapterCheckboxesContainer.innerHTML = '';
    rangeStartInput.value = '';
    rangeEndInput.value = '';
    regenerateStatus.style.display = 'none';
}

// Close modal handlers
regenerateCloseBtn.addEventListener('click', () => {
    regenerateModal.style.display = 'none';
    resetRegenerateModal();
});

cancelRegenerateBtn.addEventListener('click', () => {
    regenerateModal.style.display = 'none';
    resetRegenerateModal();
});

window.addEventListener('click', (event) => {
    if (event.target === regenerateModal) {
        regenerateModal.style.display = 'none';
        resetRegenerateModal();
    }
});

loadBooks();

// Initialize AI Terminal
let globalAITerminal = null;
if (typeof AITerminal !== 'undefined') {
    globalAITerminal = new AITerminal();
    window.globalAITerminal = globalAITerminal; // Also expose globally for debugging
    console.log('Creating AI Terminal instance:', globalAITerminal);
    console.log('sendCommand method exists?', typeof globalAITerminal.sendCommand);
    
    globalAITerminal.init('ai-terminal-container').then(() => {
        console.log('AI Terminal initialized');
        console.log('sendCommand still exists?', typeof globalAITerminal.sendCommand);
        // Terminal now starts collapsed by default, so don't add terminal-open class
    }).catch(err => {
        console.error('Failed to initialize AI Terminal:', err);
    });
} else {
    console.warn('AITerminal not available yet');
}

// Hello World button handler - wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
    const helloBtn = document.getElementById('hello-world-btn');
    if (helloBtn) {
        helloBtn.addEventListener('click', () => {
            if (!globalAITerminal) {
                alert('AI Terminal not initialized');
                return;
            }
            
            if (!globalAITerminal.currentTool) {
                alert('Please select an AI Assistant first (Claude Code or Gemini CLI)');
                return;
            }
            
            // Get the current directory (audiobook directory)
            // In the container, audiobooks are mounted at /app/audiobooks
            const currentPath = '/app/audiobooks';
            
            // Create command based on which AI tool is active
            let command;
            let commandOptions = {};
            
            if (globalAITerminal.currentTool === 'claude') {
                // Use Claude's non-interactive mode with natural language prompt
                const timestamp = new Date().toISOString();
                command = `Create a new file called hello_world.txt in the current directory with the content "Hello World! This file was created by Claude Code at ${timestamp}"`;
                
                // Use non-interactive mode with YOLO for this simple command
                commandOptions = {
                    nonInteractive: true,
                    yolo: true,  // --dangerously-skip-permissions
                    allowedTools: ['Write']  // Allow file operations
                };
            } else if (globalAITerminal.currentTool === 'gemini') {
                // Use a simpler command for Gemini non-interactive mode
                command = `Create a file at ${currentPath}/hello_world.txt with the content: Hello World! This file was created by Gemini CLI at ${new Date().toISOString()}`;
                
                // Use non-interactive mode with YOLO for this simple command
                commandOptions = {
                    nonInteractive: true,
                    yolo: true  // Auto-approve file creation
                };
            }
            
            // Send the command
            if (globalAITerminal.sendCommand) {
                globalAITerminal.sendCommand(command, commandOptions);
            } else {
                console.error('sendCommand method not available on terminal instance');
            }
        });
    }
});

// FLUX Integration
let fluxSettings = {
    modelPrecision: 'fp8',
    steps: 20,
    guidance: 3.5,
    width: 512,
    height: 512,
    sampler: 'euler',
    scheduler: 'simple'
};

let fluxModelsStatus = {};
let fluxInitialized = false;

// Initialize FLUX panel
async function initializeFluxPanel(showSetupIfNeeded = false) {
    if (fluxInitialized) return;
    
    // Check FLUX service status first
    const setupStatus = await checkFluxServiceStatus();
    if (!setupStatus.serviceReady && showSetupIfNeeded) {
        // Service not ready, show setup UI only if explicitly requested
        await showFluxSetupModal();
    }
    
    fluxInitialized = true;
    
    // Load FLUX settings
    const savedSettings = localStorage.getItem('fluxSettings');
    if (savedSettings) {
        fluxSettings = { ...fluxSettings, ...JSON.parse(savedSettings) };
    }
    
    // Get available settings from backend
    try {
        const settings = await ipcRenderer.invoke('flux-get-settings');
        if (!settings.error) {
            renderFluxSettings(settings);
        } else {
            // Use default settings when service is not running
            renderFluxSettings({
                steps_min: 1,
                steps_max: 50,
                guidance_min: 0.0,
                guidance_max: 10.0,
                available_samplers: ["euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral"],
                available_schedulers: ["simple", "normal", "karras", "exponential"]
            });
        }
    } catch (error) {
        console.error('Error loading FLUX settings:', error);
    }
    
    // Update models status
    await updateFluxModelsStatus();
    
    // Set up event listeners
    setupFluxEventListeners();
}

// Update FLUX service status indicator
async function updateFluxServiceStatus() {
    const statusIndicator = document.querySelector('.status-indicator');
    const statusText = document.querySelector('.status-text');
    const toggleBtn = document.getElementById('flux-service-toggle');
    
    try {
        const status = await ipcRenderer.invoke('flux-get-setup-status');
        
        // Check if using ComfyUI
        if (status.comfyUI && status.comfyUI.pathSet) {
            if (!status.comfyUI.valid) {
                statusIndicator.className = 'status-indicator stopped';
                statusText.textContent = 'ComfyUI invalid';
                toggleBtn.style.display = 'none';
            } else if (status.service && status.service.running) {
                statusIndicator.className = 'status-indicator running';
                statusText.textContent = 'ComfyUI running';
                toggleBtn.style.display = 'inline-block';
                toggleBtn.textContent = 'Stop ComfyUI';
                toggleBtn.disabled = false;
            } else {
                statusIndicator.className = 'status-indicator stopped';
                statusText.textContent = 'ComfyUI stopped';
                toggleBtn.style.display = 'inline-block';
                toggleBtn.textContent = 'Start ComfyUI';
                toggleBtn.disabled = false;
            }
        } 
        // Fall back to Docker status
        else if (!status.docker || !status.docker.installed) {
            statusIndicator.className = 'status-indicator stopped';
            statusText.textContent = 'Docker not installed';
            toggleBtn.style.display = 'none';
        } else if (!status.docker.running) {
            statusIndicator.className = 'status-indicator stopped';
            statusText.textContent = 'Docker not running';
            toggleBtn.style.display = 'none';
        } else if (status.service && status.service.running && status.service.healthy) {
            statusIndicator.className = 'status-indicator running';
            statusText.textContent = 'Docker service running';
            toggleBtn.style.display = 'inline-block';
            toggleBtn.textContent = 'Stop Service';
            toggleBtn.disabled = false;
        } else if (status.service && status.service.running && !status.service.healthy) {
            statusIndicator.className = 'status-indicator starting';
            statusText.textContent = 'Docker service starting...';
            toggleBtn.style.display = 'none';
        } else {
            statusIndicator.className = 'status-indicator stopped';
            statusText.textContent = 'Service stopped';
            toggleBtn.style.display = 'inline-block';
            toggleBtn.textContent = 'Start Service';
            toggleBtn.disabled = false;
        }
    } catch (error) {
        statusIndicator.className = 'status-indicator stopped';
        statusText.textContent = 'Error checking status';
        toggleBtn.style.display = 'none';
    }
}

// Check FLUX service status
async function checkFluxServiceStatus() {
    try {
        const status = await ipcRenderer.invoke('flux-get-setup-status');
        const serviceReady = status.service && status.service.running && status.service.healthy;
        return { ...status, serviceReady };
    } catch (error) {
        console.error('Error checking FLUX service status:', error);
        return { error: error.message, serviceReady: false };
    }
}

// Show FLUX setup modal
async function showFluxSetupModal() {
    // Check if ComfyUI is configured
    const status = await ipcRenderer.invoke('flux-get-setup-status');
    const isComfyUI = status.comfyUI && status.comfyUI.pathSet;
    
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal flux-setup-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <h2>FLUX Service Setup</h2>
                <p>${isComfyUI ? 'Starting local ComfyUI service...' : 'Setting up FLUX image generation service with Docker...'}</p>
                <div class="setup-progress">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: 0%"></div>
                    </div>
                    <div class="progress-text">${isComfyUI ? 'Checking ComfyUI...' : 'Checking Docker...'}</div>
                </div>
                <div class="setup-info">
                    <p style="font-size: 12px; color: #666; margin-top: 10px;">
                        ${isComfyUI 
                            ? 'This will start your local ComfyUI installation in headless mode.'
                            : 'This will start a Docker container running ComfyUI with FLUX support. First time setup may take a few minutes.'}
                    </p>
                    ${!isComfyUI ? '<p style="font-size: 12px; color: #666;">Tip: You can configure a local ComfyUI installation in Settings for faster startup.</p>' : ''}
                </div>
                <div class="setup-buttons">
                    <button class="cancel-btn">Cancel</button>
                    <button class="start-btn">Start Service</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.style.display = 'block';

        const progressFill = modal.querySelector('.progress-fill');
        const progressText = modal.querySelector('.progress-text');
        const cancelBtn = modal.querySelector('.cancel-btn');
        const startBtn = modal.querySelector('.start-btn');

        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(modal);
            resolve({ success: false });
        });

        startBtn.addEventListener('click', async () => {
            startBtn.disabled = true;
            cancelBtn.disabled = true;
            
            // Start the service
            ipcRenderer.invoke('flux-start-service').then((result) => {
                if (result.error) {
                    progressText.textContent = `Error: ${result.error}`;
                    setTimeout(() => {
                        document.body.removeChild(modal);
                        resolve({ success: false, error: result.error });
                    }, 3000);
                } else {
                    progressText.textContent = 'Service started successfully!';
                    progressFill.style.width = '100%';
                    setTimeout(() => {
                        document.body.removeChild(modal);
                        resolve({ success: true });
                    }, 1000);
                }
            }).catch((error) => {
                progressText.textContent = `Error: ${error.message}`;
                setTimeout(() => {
                    document.body.removeChild(modal);
                    resolve({ success: false, error: error.message });
                }, 3000);
            });
        });

        // Listen for progress updates
        ipcRenderer.on('flux-setup-progress', (event, progress) => {
            if (progress.progress) {
                progressFill.style.width = `${progress.progress}%`;
            }
            if (progress.message) {
                progressText.textContent = progress.message;
            }
        });
    });
}

// Render FLUX settings controls
function renderFluxSettings(settings) {
    const settingsContent = document.getElementById('flux-settings-content');
    
    settingsContent.innerHTML = `
        <div class="flux-setting-row">
            <label class="flux-setting-label">Model Precision:</label>
            <div class="flux-precision-toggle">
                <button class="flux-precision-btn ${fluxSettings.modelPrecision === 'fp8' ? 'active' : ''}" data-precision="fp8">FP8 (Faster)</button>
                <button class="flux-precision-btn ${fluxSettings.modelPrecision === 'fp16' ? 'active' : ''}" data-precision="fp16">FP16 (Better Quality)</button>
            </div>
        </div>
        
        <div class="flux-setting-row">
            <label class="flux-setting-label">Steps: <span class="flux-setting-value">${fluxSettings.steps}</span></label>
            <input type="range" class="flux-slider" id="flux-steps" 
                   min="${settings.steps_min}" max="${settings.steps_max}" 
                   value="${fluxSettings.steps}">
        </div>
        
        <div class="flux-setting-row">
            <label class="flux-setting-label">Guidance: <span class="flux-setting-value">${fluxSettings.guidance}</span></label>
            <input type="range" class="flux-slider" id="flux-guidance" 
                   min="${settings.guidance_min}" max="${settings.guidance_max}" 
                   step="0.5" value="${fluxSettings.guidance}">
        </div>
        
        <div class="flux-setting-row">
            <label class="flux-setting-label">Resolution:</label>
            <select class="flux-select" id="flux-resolution">
                <option value="512x512" ${fluxSettings.width === 512 ? 'selected' : ''}>512x512</option>
                <option value="768x768" ${fluxSettings.width === 768 ? 'selected' : ''}>768x768</option>
                <option value="1024x1024" ${fluxSettings.width === 1024 ? 'selected' : ''}>1024x1024</option>
                <option value="1536x1536" ${fluxSettings.width === 1536 ? 'selected' : ''}>1536x1536</option>
            </select>
        </div>
        
        <div class="flux-setting-row">
            <label class="flux-setting-label">Sampler:</label>
            <select class="flux-select" id="flux-sampler">
                ${settings.available_samplers.map(sampler => 
                    `<option value="${sampler}" ${fluxSettings.sampler === sampler ? 'selected' : ''}>${sampler}</option>`
                ).join('')}
            </select>
        </div>
        
        <div class="flux-setting-row">
            <label class="flux-setting-label">Scheduler:</label>
            <select class="flux-select" id="flux-scheduler">
                ${settings.available_schedulers.map(scheduler => 
                    `<option value="${scheduler}" ${fluxSettings.scheduler === scheduler ? 'selected' : ''}>${scheduler}</option>`
                ).join('')}
            </select>
        </div>
    `;
}

// Update FLUX models status
async function updateFluxModelsStatus() {
    try {
        // Check if any model is currently downloading
        const hasActiveDownload = Object.values(fluxModelsStatus).some(model => model.downloading);
        
        const status = await ipcRenderer.invoke('flux-get-models-status');
        if (!status.error) {
            // Preserve download states if there are active downloads
            if (hasActiveDownload) {
                Object.keys(status).forEach(key => {
                    if (fluxModelsStatus[key] && fluxModelsStatus[key].downloading) {
                        status[key].downloading = fluxModelsStatus[key].downloading;
                        status[key].progress = fluxModelsStatus[key].progress;
                    }
                });
            }
            
            fluxModelsStatus = status;
            
            // Only re-render if no active downloads
            if (!hasActiveDownload) {
                renderFluxModelsList();
            }
        } else {
            // Service not running - clear models list
            fluxModelsStatus = {};
            const modelsList = document.getElementById('flux-models-list');
            if (modelsList) {
                modelsList.innerHTML = '<div style="text-align: center; color: #666; padding: 20px;">Start the service to manage models</div>';
            }
        }
    } catch (error) {
        console.error('Error getting FLUX models status:', error);
    }
}

// Render FLUX models list
function renderFluxModelsList() {
    const modelsList = document.getElementById('flux-models-list');
    modelsList.innerHTML = '';
    
    // Group models by type
    const essentialModels = ['clip_l', 'ae'];
    const textEncoders = ['t5xxl_fp8', 't5xxl_fp16'];
    const kontextModels = ['flux_kontext', 'flux_kontext_fp8'];
    
    // Render essential models
    modelsList.innerHTML += '<div style="font-size: 12px; color: #666; margin-bottom: 8px;">Essential Models:</div>';
    essentialModels.forEach(key => renderModelItem(modelsList, key, fluxModelsStatus[key]));
    
    // Render text encoders
    modelsList.innerHTML += '<div style="font-size: 12px; color: #666; margin: 12px 0 8px;">Text Encoders (choose one):</div>';
    textEncoders.forEach(key => renderModelItem(modelsList, key, fluxModelsStatus[key]));
    
    // Render Kontext models
    modelsList.innerHTML += '<div style="font-size: 12px; color: #666; margin: 12px 0 8px;">FLUX.1 Kontext Models (choose one):</div>';
    kontextModels.forEach(key => renderModelItem(modelsList, key, fluxModelsStatus[key]));
}

// Render individual model item
function renderModelItem(container, modelKey, modelInfo) {
    const modelDiv = document.createElement('div');
    modelDiv.className = 'flux-model-item';
    modelDiv.id = `flux-model-${modelKey}`;
    
    const statusClass = modelInfo.available ? 'available' : (modelInfo.downloading ? 'downloading' : 'not-available');
    const statusText = modelInfo.available ? 'Ready' : (modelInfo.downloading ? 'Downloading...' : 'Not Downloaded');
    
    modelDiv.innerHTML = `
        <div class="flux-model-header">
            <div>
                <div class="flux-model-name">${modelInfo.name}</div>
                <div class="flux-model-size">${modelInfo.size}</div>
            </div>
            <div class="flux-model-status">
                <span class="flux-model-badge ${statusClass}">${statusText}</span>
                ${!modelInfo.available && !modelInfo.downloading ? 
                    `<button class="flux-download-btn" data-model="${modelKey}">Download</button>` : ''}
            </div>
        </div>
        ${modelInfo.downloading ? `
            <div class="flux-download-progress">
                <div class="flux-progress-bar">
                    <div class="flux-progress-fill" style="width: ${modelInfo.progress || 0}%"></div>
                </div>
                <div class="flux-progress-text">Downloading... ${modelInfo.progress || 0}%</div>
            </div>
        ` : ''}
    `;
    
    container.appendChild(modelDiv);
}

// Set up FLUX event listeners
function setupFluxEventListeners() {
    // Model precision toggle
    document.querySelectorAll('.flux-precision-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.flux-precision-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            fluxSettings.modelPrecision = e.target.dataset.precision;
            saveFluxSettings();
        });
    });
    
    // Settings sliders
    document.getElementById('flux-steps').addEventListener('input', (e) => {
        fluxSettings.steps = parseInt(e.target.value);
        e.target.previousElementSibling.querySelector('.flux-setting-value').textContent = e.target.value;
        saveFluxSettings();
    });
    
    document.getElementById('flux-guidance').addEventListener('input', (e) => {
        fluxSettings.guidance = parseFloat(e.target.value);
        e.target.previousElementSibling.querySelector('.flux-setting-value').textContent = e.target.value;
        saveFluxSettings();
    });
    
    // Resolution select
    document.getElementById('flux-resolution').addEventListener('change', (e) => {
        const [width, height] = e.target.value.split('x').map(Number);
        fluxSettings.width = width;
        fluxSettings.height = height;
        saveFluxSettings();
    });
    
    // Sampler and scheduler
    document.getElementById('flux-sampler').addEventListener('change', (e) => {
        fluxSettings.sampler = e.target.value;
        saveFluxSettings();
    });
    
    document.getElementById('flux-scheduler').addEventListener('change', (e) => {
        fluxSettings.scheduler = e.target.value;
        saveFluxSettings();
    });
    
    // Model download buttons
    document.addEventListener('click', async (e) => {
        if (e.target.classList.contains('flux-download-btn')) {
            const modelKey = e.target.dataset.model;
            const modelInfo = fluxModelsStatus[modelKey];
            
            // Check if model requires authentication
            let hfToken = null;
            if (modelInfo.requires_auth || modelKey.includes('flux_dev') || modelKey.includes('flux_kontext') || modelKey === 'ae') {
                // First check if token exists in settings
                const tokenCheck = await ipcRenderer.invoke('check-hf-token');
                
                if (tokenCheck.hasToken) {
                    // Token exists in settings, proceed with download
                    e.target.disabled = true;
                    e.target.textContent = 'Starting...';
                    
                    const result = await ipcRenderer.invoke('flux-download-model', { modelKey });
                    if (result.error) {
                        alert(`Error downloading model: ${result.error}`);
                        e.target.disabled = false;
                        e.target.textContent = 'Download';
                    } else {
                        // Update model status to show it's downloading
                        fluxModelsStatus[modelKey].downloading = true;
                        fluxModelsStatus[modelKey].progress = 0;
                        renderFluxModelsList();
                    }
                    return;
                }
                
                // No token in settings, show modal
                const modal = document.createElement('div');
                modal.className = 'modal';
                modal.innerHTML = `
                    <div class="modal-content" style="max-width: 500px;">
                        <h2>HuggingFace Token Required</h2>
                        <p>This model requires authentication. Please enter your HuggingFace token:</p>
                        <p style="font-size: 0.9em; color: #666;">You need to accept the model license at <a href="https://huggingface.co/black-forest-labs" target="_blank">huggingface.co</a></p>
                        <p style="font-size: 0.9em; color: #666; margin-top: 10px;"><strong>Tip:</strong> You can save your token in the Settings panel to avoid entering it each time.</p>
                        <input type="password" id="hf-token-input" style="width: 100%; padding: 8px; margin: 10px 0; box-sizing: border-box;" placeholder="hf_...">
                        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
                            <button id="hf-token-cancel" style="padding: 8px 16px;">Cancel</button>
                            <button id="hf-token-submit" style="padding: 8px 16px; background: #4CAF50; color: white; border: none; cursor: pointer;">Download</button>
                        </div>
                    </div>
                `;
                
                document.body.appendChild(modal);
                
                // Focus the input
                const tokenInput = document.getElementById('hf-token-input');
                tokenInput.focus();
                
                // Handle token submission
                const submitToken = async () => {
                    hfToken = tokenInput.value.trim();
                    if (!hfToken) {
                        alert('Please enter a token');
                        return;
                    }
                    
                    document.body.removeChild(modal);
                    
                    e.target.disabled = true;
                    e.target.textContent = 'Starting...';
                    
                    const result = await ipcRenderer.invoke('flux-download-model', { modelKey, hfToken });
                    if (result.error) {
                        alert(`Error downloading model: ${result.error}`);
                        e.target.disabled = false;
                        e.target.textContent = 'Download';
                    } else {
                        // Update model status to show it's downloading
                        fluxModelsStatus[modelKey].downloading = true;
                        fluxModelsStatus[modelKey].progress = 0;
                        renderFluxModelsList();
                    }
                };
                
                // Event listeners
                document.getElementById('hf-token-submit').addEventListener('click', submitToken);
                document.getElementById('hf-token-cancel').addEventListener('click', () => {
                    document.body.removeChild(modal);
                });
                tokenInput.addEventListener('keypress', (event) => {
                    if (event.key === 'Enter') {
                        submitToken();
                    }
                });
                
                return;
            }
            
            // No token required
            e.target.disabled = true;
            e.target.textContent = 'Starting...';
            
            const result = await ipcRenderer.invoke('flux-download-model', { modelKey, hfToken });
            if (result.error) {
                alert(`Error downloading model: ${result.error}`);
                e.target.disabled = false;
                e.target.textContent = 'Download';
            } else {
                // Update model status to show it's downloading
                fluxModelsStatus[modelKey].downloading = true;
                fluxModelsStatus[modelKey].progress = 0;
                renderFluxModelsList();
            }
        }
    });
    
    // Test generation button
    document.getElementById('flux-test-generate').addEventListener('click', generateTestImage);
    
    // Kontext generation button
    document.getElementById('kontext-generate').addEventListener('click', generateKontextImage);
    
    // Kontext character select event listeners
    document.getElementById('kontext-char1').addEventListener('change', (e) => {
        updateKontextCharacterPreview(e.target.value, 'kontext-char1-preview');
    });
    
    document.getElementById('kontext-char2').addEventListener('change', (e) => {
        updateKontextCharacterPreview(e.target.value, 'kontext-char2-preview');
    });
}

// Save FLUX settings to localStorage
function saveFluxSettings() {
    localStorage.setItem('fluxSettings', JSON.stringify(fluxSettings));
}

// Generate test image with FLUX
async function generateTestImage() {
    const prompt = document.getElementById('flux-test-prompt').value.trim();
    if (!prompt) {
        alert('Please enter a prompt');
        return;
    }
    
    // Check if we're using RunPod - if so, skip local model validation
    const currentService = await ipcRenderer.invoke('get-generation-service');
    if (currentService !== 'runpod') {
        // Check if required models are available (only for local generation)
        const requiredModels = ['clip_l', 'ae'];
        const textEncoder = fluxSettings.modelPrecision === 'fp16' ? 't5xxl_fp16' : 't5xxl_fp8';
        const fluxModel = fluxSettings.modelPrecision === 'fp8' ? 'flux_kontext_fp8' : 'flux_kontext';
        
        requiredModels.push(textEncoder, fluxModel);
        
        const missingModels = requiredModels.filter(key => !fluxModelsStatus[key]?.available);
        if (missingModels.length > 0) {
            alert(`Please download required models first: ${missingModels.map(k => fluxModelsStatus[k]?.name).join(', ')}`);
            return;
        }
    }
    
    const generateBtn = document.getElementById('flux-test-generate');
    const resultDiv = document.getElementById('flux-test-result');
    
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';
    
    resultDiv.innerHTML = `
        <div class="flux-generating">
            <div class="loading-spinner"></div>
            <div class="flux-generating-text">Initializing generation...</div>
        </div>
    `;
    
    try {
        // Start generation
        const result = await ipcRenderer.invoke('flux-generate-image', {
            prompt,
            settings: fluxSettings
        });
        
        if (result.error) {
            throw new Error(result.error);
        }
        
        // Handle RunPod job
        if (result.service === 'runpod') {
            const jobId = result.jobId;
            let completed = false;
            let attempts = 0;
            const maxAttempts = 120; // 10 minutes
            
            while (!completed && attempts < maxAttempts) {
                const status = await ipcRenderer.invoke('flux-get-job-status', { jobId, service: 'runpod' });
                
                if (status.error) {
                    throw new Error(status.error);
                }
                
                if (status.status === 'success') {
                    completed = true;
                    
                    // Display the base64 image directly
                    if (status.image) {
                        resultDiv.innerHTML = `
                            <img src="data:image/png;base64,${status.image}" alt="Generated image" class="flux-result-image">
                        `;
                    }
                } else if (status.status === 'error') {
                    throw new Error(status.error || 'Generation failed');
                } else if (status.status === 'processing') {
                    // Update progress if available
                    if (status.progress) {
                        resultDiv.querySelector('.flux-generating-text').textContent = `Generating... ${Math.round(status.progress * 100)}%`;
                    }
                }
                
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
            }
            
            if (!completed) {
                throw new Error('Generation timeout');
            }
        } else {
            // Handle local generation
            const jobId = result.job_id;
            let completed = false;
            let attempts = 0;
            const maxAttempts = 120; // 10 minutes
            
            while (!completed && attempts < maxAttempts) {
                const status = await ipcRenderer.invoke('flux-get-job-status', { jobId });
                
                if (status.error) {
                    throw new Error(status.error);
                }
                
                if (status.status === 'completed') {
                    completed = true;
                    
                    // Get the generated image
                    const imageBuffer = await ipcRenderer.invoke('flux-get-image', { jobId });
                    if (imageBuffer && !imageBuffer.error) {
                        const blob = new Blob([imageBuffer], { type: 'image/png' });
                        const imageUrl = URL.createObjectURL(blob);
                        
                        resultDiv.innerHTML = `
                            <img src="${imageUrl}" alt="Generated image" class="flux-result-image">
                        `;
                    }
                } else if (status.status === 'failed') {
                    throw new Error(status.error || 'Generation failed');
                }
                
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
            }
            
            if (!completed) {
                throw new Error('Generation timeout');
            }
        }
        
    } catch (error) {
        console.error('Error generating image:', error);
        resultDiv.innerHTML = `<div style="color: red; padding: 10px;">Error: ${error.message}</div>`;
    } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Test Image';
    }
}

// Generate Kontext image with character fusion
async function generateKontextImage() {
    const char1Select = document.getElementById('kontext-char1');
    const char2Select = document.getElementById('kontext-char2');
    const promptTextarea = document.getElementById('kontext-prompt');
    const resultDiv = document.getElementById('kontext-result');
    const generateBtn = document.getElementById('kontext-generate');
    
    // Validate selections
    if (!char1Select.value || !char2Select.value) {
        alert('Please select both characters for fusion');
        return;
    }
    
    if (!promptTextarea.value.trim()) {
        alert('Please enter a scene description');
        return;
    }
    
    // Get selected characters
    const char1 = currentCharacters[parseInt(char1Select.value)];
    const char2 = currentCharacters[parseInt(char2Select.value)];
    
    // Check if characters have photos
    if (!char1.photo || char1.photo === 'placeholder.png' || !char2.photo || char2.photo === 'placeholder.png') {
        alert('Both characters must have portrait images. Please generate images for characters without portraits first.');
        return;
    }
    
    // Check required models
    const requiredModels = ['clip_l', 'ae'];
    const textEncoder = fluxSettings.modelPrecision === 'fp16' ? 't5xxl_fp16' : 't5xxl_fp8';
    const fluxModel = fluxSettings.modelPrecision === 'fp8' ? 'flux_kontext_fp8' : 'flux_kontext';
    
    requiredModels.push(textEncoder, fluxModel);
    
    const missingModels = requiredModels.filter(key => !fluxModelsStatus[key]?.available);
    if (missingModels.length > 0) {
        alert(`Please download required FLUX Kontext models first: ${missingModels.map(k => fluxModelsStatus[k]?.name).join(', ')}`);
        return;
    }
    
    // Disable button and show loading
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';
    
    resultDiv.innerHTML = `
        <div class="flux-generating">
            <div class="loading-spinner"></div>
            <div class="flux-generating-text">Creating character fusion scene...</div>
        </div>
    `;
    
    try {
        // Construct full image paths
        const bookDir = path.join(audiobooksDir, currentBook);
        const char1ImagePath = path.join(bookDir, char1.photo);
        const char2ImagePath = path.join(bookDir, char2.photo);
        
        // Convert character images to base64
        const char1Base64 = await imagePathToBase64(char1ImagePath);
        const char2Base64 = await imagePathToBase64(char2ImagePath);
        
        // Start generation
        const result = await ipcRenderer.invoke('flux-generate-kontext', {
            prompt: promptTextarea.value,
            character_image_1: char1Base64,
            character_image_2: char2Base64,
            settings: fluxSettings
        });
        
        if (result.error) {
            throw new Error(result.error);
        }
        
        // Handle RunPod job
        if (result.service === 'runpod') {
            const jobId = result.jobId;
            let completed = false;
            let attempts = 0;
            const maxAttempts = 120; // 10 minutes
            
            while (!completed && attempts < maxAttempts) {
                const status = await ipcRenderer.invoke('flux-get-job-status', { jobId, service: 'runpod' });
                
                if (status.error) {
                    throw new Error(status.error);
                }
                
                if (status.status === 'success') {
                    completed = true;
                    
                    // For RunPod, the image is in base64
                    if (status.image) {
                        resultDiv.innerHTML = `
                            <img src="data:image/png;base64,${status.image}" alt="Character fusion scene" class="flux-result-image">
                            <div class="kontext-result-info">
                                <p><strong>Characters:</strong> ${char1.name} & ${char2.name}</p>
                                <p><strong>Scene:</strong> ${promptTextarea.value}</p>
                            </div>
                        `;
                    }
                } else if (status.status === 'error') {
                    throw new Error(status.error || 'Generation failed');
                } else {
                    // Still processing
                    const progressText = resultDiv.querySelector('.flux-generating-text');
                    if (progressText) {
                        progressText.textContent = `Generating fusion scene... (${attempts * 5}s)`;
                    }
                }
                
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
            }
            
            if (!completed) {
                throw new Error('Generation timeout');
            }
        } else {
            // Handle local generation
            const jobId = result.job_id;
            let completed = false;
            let attempts = 0;
            const maxAttempts = 120; // 10 minutes
            
            while (!completed && attempts < maxAttempts) {
                const status = await ipcRenderer.invoke('flux-get-job-status', { jobId });
                
                if (status.error) {
                    throw new Error(status.error);
                }
                
                if (status.status === 'completed') {
                    completed = true;
                    
                    // Get the generated image
                    const imageBuffer = await ipcRenderer.invoke('flux-get-image', { jobId });
                    if (imageBuffer && !imageBuffer.error) {
                        const blob = new Blob([imageBuffer], { type: 'image/png' });
                        const imageUrl = URL.createObjectURL(blob);
                        
                        resultDiv.innerHTML = `
                            <img src="${imageUrl}" alt="Character fusion scene" class="flux-result-image">
                            <div class="kontext-result-info">
                                <p><strong>Characters:</strong> ${char1.name} & ${char2.name}</p>
                                <p><strong>Scene:</strong> ${promptTextarea.value}</p>
                            </div>
                        `;
                    }
                } else if (status.status === 'failed') {
                    throw new Error(status.error || 'Generation failed');
                }
            }
            
            // Update progress text
            if (!completed) {
                const progressText = resultDiv.querySelector('.flux-generating-text');
                if (progressText) {
                    progressText.textContent = `Processing... (${Math.floor((attempts / maxAttempts) * 100)}%)`;
                }
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        }
        
        if (!completed) {
            throw new Error('Generation timeout');
        }
        
    } catch (error) {
        console.error('Error generating Kontext image:', error);
        resultDiv.innerHTML = `<div style="color: red; padding: 10px;">Error: ${error.message}</div>`;
    } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Kontext Image';
    }
}

// Helper function to convert image path to base64
async function imagePathToBase64(imagePath) {
    try {
        // Read the file directly from the file system
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        return base64;
    } catch (error) {
        console.error('Error converting image to base64:', error);
        return null;
    }
}

// Helper function to save image blob to file
async function saveImageFromBlob(blob, filePath) {
    const buffer = Buffer.from(await blob.arrayBuffer());
    await fs.promises.writeFile(filePath, buffer);
}

// Save characters data to JSON file
async function saveCharactersData() {
    if (!currentBook || !currentCharacters) return;
    
    const bookDir = path.join(audiobooksDir, currentBook);
    const charactersJsonPath = getCharactersFilePath(currentBook);
    
    try {
        await fs.promises.writeFile(
            charactersJsonPath, 
            JSON.stringify(currentCharacters, null, 2), 
            'utf-8'
        );
        console.log('Characters data saved successfully');
    } catch (error) {
        console.error('Error saving characters data:', error);
    }
}

// Get all image versions for a character
function getCharacterImageVersions(characterName) {
    const bookDir = path.join(audiobooksDir, currentBook);
    const profileImagesDir = path.join(bookDir, 'character_profile_images');
    
    if (!fs.existsSync(profileImagesDir)) {
        return [];
    }
    
    // Get all files in the directory
    const files = fs.readdirSync(profileImagesDir);
    
    // Filter files for this character
    const characterPrefix = characterName.toLowerCase().replace(/\s+/g, '_');
    const characterImages = files.filter(file => 
        file.startsWith(characterPrefix + '_') && file.endsWith('.png')
    );
    
    // Sort by timestamp (newest first)
    const imageVersions = characterImages.map(filename => {
        const match = filename.match(/_(\d+)\.png$/);
        const timestamp = match ? parseInt(match[1]) : 0;
        return {
            filename: filename,
            path: path.join(profileImagesDir, filename),
            relativePath: `character_profile_images/${filename}`,
            timestamp: timestamp,
            date: new Date(timestamp)
        };
    }).sort((a, b) => a.timestamp - b.timestamp);
    
    return imageVersions;
}

// Open modal for editing character image with AI
function openEditCharacterModal(character, imageElement) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>${character.name} - Character Image</h3>
                <span class="close">&times;</span>
            </div>
            <div class="modal-body">
                <div class="edit-character-preview">
                    <img src="${imageElement.src}" alt="${character.name}">
                    <div class="modal-version-controls" style="display: none;">
                        <button class="version-nav-btn prev-btn">‹</button>
                        <span class="version-info"></span>
                        <button class="version-nav-btn next-btn">›</button>
                    </div>
                </div>
                <div class="edit-character-form">
                    <label>Edit Prompt:</label>
                    <textarea id="edit-character-prompt" rows="4" 
                        placeholder="Describe how you want to modify the character image (e.g., 'change clothing to medieval armor', 'add glasses', 'change background to forest')..."></textarea>
                    <div class="edit-options">
                        <label>
                            <input type="checkbox" id="preserve-face" checked>
                            Preserve face/identity
                        </label>
                    </div>
                    <div class="modal-buttons">
                        <button id="generate-new-btn" class="primary-btn">Generate New Image</button>
                        <button id="start-edit-btn" class="primary-btn">Start Editing</button>
                        <button id="cancel-edit-btn" class="secondary-btn">Cancel</button>
                    </div>
                </div>
                <div id="edit-result" style="display: none;">
                    <div class="loading-spinner"></div>
                    <div class="edit-status">Processing edit...</div>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Show the modal
    modal.style.display = 'block';
    
    // Add event listeners
    const closeBtn = modal.querySelector('.close');
    const cancelBtn = modal.querySelector('#cancel-edit-btn');
    const startEditBtn = modal.querySelector('#start-edit-btn');
    const generateNewBtn = modal.querySelector('#generate-new-btn');
    const promptTextarea = modal.querySelector('#edit-character-prompt');
    
    const closeModal = () => {
        modal.remove();
    };
    
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });
    
    // Handler for Generate New Image button
    generateNewBtn.addEventListener('click', async () => {
        const imageDescription = character.imagePrompt || character.baseDescription || character.description;
        
        // Generate new image without closing modal and without auto-setting it
        await generateFluxCharacterImageForModal(character, imageDescription, modal, () => {
            // Refresh version navigation after new image is generated
            const newVersions = getCharacterImageVersions(character.name);
            if (newVersions.length > versions.length) {
                // Update versions array and navigate to the new image
                versions = newVersions;
                currentVersionIndex = versions.length - 1; // Go to the newest image (now at the end)
                
                // Show version controls if they were hidden
                if (versionControls.style.display !== 'flex') {
                    versionControls.style.display = 'flex';
                }
                
                updateVersionDisplay();
            }
        });
    });
    
    startEditBtn.addEventListener('click', async () => {
        const prompt = promptTextarea.value.trim();
        if (!prompt) {
            alert('Please enter an edit prompt');
            return;
        }
        
        // Show loading state
        modal.querySelector('.edit-character-form').style.display = 'none';
        modal.querySelector('#edit-result').style.display = 'block';
        
        try {
            // Convert image to base64
            const response = await fetch(imageElement.src);
            const blob = await response.blob();
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64 = reader.result.split(',')[1];
                    resolve(base64);
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            
            // Call FLUX edit endpoint
            const result = await ipcRenderer.invoke('flux-edit-image', {
                prompt: prompt,
                image: base64,
                settings: fluxSettings
            });
            
            if (result.error) {
                throw new Error(result.error);
            }
            
            // Poll for completion
            const jobId = result.job_id;
            let completed = false;
            let attempts = 0;
            const maxAttempts = 120; // 10 minutes
            
            const statusDiv = modal.querySelector('.edit-status');
            
            while (!completed && attempts < maxAttempts) {
                const status = await ipcRenderer.invoke('flux-get-job-status', { jobId });
                
                if (status.error) {
                    throw new Error(status.error);
                }
                
                if (status.status === 'completed') {
                    completed = true;
                    
                    // Get the edited image
                    const imageBuffer = await ipcRenderer.invoke('flux-get-image', { jobId });
                    if (imageBuffer && !imageBuffer.error) {
                        const blob = new Blob([imageBuffer], { type: 'image/png' });
                        const imageUrl = URL.createObjectURL(blob);
                        
                        // Save the edited image
                        const bookDir = path.join(audiobooksDir, currentBook);
                        const profileImagesDir = path.join(bookDir, 'character_profile_images');
                        
                        // Create character_profile_images directory if it doesn't exist
                        if (!fs.existsSync(profileImagesDir)) {
                            fs.mkdirSync(profileImagesDir, { recursive: true });
                        }
                        
                        const timestamp = Date.now();
                        const newFileName = `${character.name.toLowerCase().replace(/\s+/g, '_')}_${timestamp}.png`;
                        const newFilePath = path.join(profileImagesDir, newFileName);
                        
                        // Save the image file
                        await saveImageFromBlob(blob, newFilePath);
                        
                        // Update character photo with relative path
                        character.photo = `character_profile_images/${newFileName}`;
                        imageElement.src = newFilePath;
                        
                        // Save updated characters data
                        await saveCharactersData();
                        
                        // Update the current character in the array
                        const charIndex = currentCharacters.findIndex(c => c.name === character.name);
                        if (charIndex !== -1) {
                            currentCharacters[charIndex] = character;
                        }
                        
                        // Refresh the character display to show new version
                        renderCharacters(currentCharacters);
                        
                        // Update the preview image in the modal
                        const previewImg = modal.querySelector('.edit-character-preview img');
                        if (previewImg) {
                            previewImg.src = newFilePath;
                            // Add animation class
                            previewImg.classList.add('updated');
                            setTimeout(() => previewImg.classList.remove('updated'), 600);
                        }
                        
                        // Show success message and reset form
                        statusDiv.textContent = 'Edit completed successfully!';
                        
                        // Reset the form for potential next edit
                        setTimeout(() => {
                            // Hide result section and show form again
                            modal.querySelector('#edit-result').style.display = 'none';
                            modal.querySelector('.edit-character-form').style.display = 'block';
                            
                            // Clear the prompt textarea for next edit
                            promptTextarea.value = '';
                            promptTextarea.focus();
                            
                            // Update the modal title to reflect it's ready for another edit
                            const modalTitle = modal.querySelector('.modal-header h3');
                            if (modalTitle) {
                                modalTitle.textContent = `${character.name} - Character Image (Updated)`;
                            }
                        }, 2000);
                    }
                } else if (status.status === 'failed') {
                    throw new Error(status.error || 'Edit failed');
                }
                
                // Update progress
                if (!completed) {
                    statusDiv.textContent = `Processing edit... (${Math.floor((attempts / maxAttempts) * 100)}%)`;
                }
                
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
            }
            
            if (!completed) {
                throw new Error('Edit timeout');
            }
            
        } catch (error) {
            console.error('Error editing character image:', error);
            modal.querySelector('.edit-status').textContent = `Error: ${error.message}`;
            modal.querySelector('.loading-spinner').style.display = 'none';
        }
    });
    
    // Set up version navigation
    let versions = getCharacterImageVersions(character.name);
    let currentVersionIndex = versions.findIndex(v => v.relativePath === character.photo);
    if (currentVersionIndex === -1) currentVersionIndex = 0;
    
    const versionControls = modal.querySelector('.modal-version-controls');
    const prevBtn = modal.querySelector('.modal-version-controls .prev-btn');
    const nextBtn = modal.querySelector('.modal-version-controls .next-btn');
    const versionInfo = modal.querySelector('.modal-version-controls .version-info');
    const previewImg = modal.querySelector('.edit-character-preview img');
    
    // Update version display function (defined at modal scope)
    const updateVersionDisplay = () => {
            const version = versions[currentVersionIndex];
            previewImg.src = version.path;
            versionInfo.textContent = `Version ${currentVersionIndex + 1} of ${versions.length}`;
            prevBtn.disabled = currentVersionIndex === 0;
            nextBtn.disabled = currentVersionIndex === versions.length - 1;
            
            // Add "Use This Version" button if not current
            let selectBtn = modal.querySelector('.select-modal-version-btn');
            if (version.relativePath !== character.photo) {
                if (!selectBtn) {
                    selectBtn = document.createElement('button');
                    selectBtn.classList.add('select-modal-version-btn');
                    selectBtn.textContent = 'Use This Version';
                    versionControls.appendChild(selectBtn);
                    
                    selectBtn.addEventListener('click', async () => {
                        // Use the current version based on currentVersionIndex
                        const selectedVersion = versions[currentVersionIndex];
                        character.photo = selectedVersion.relativePath;
                        await saveCharactersData();
                        
                        // Update the current character in the array
                        const charIndex = currentCharacters.findIndex(c => c.name === character.name);
                        if (charIndex !== -1) {
                            currentCharacters[charIndex] = character;
                        }
                        
                        renderCharacters(currentCharacters);
                        selectBtn.remove();
                        
                        // Update modal title
                        const modalTitle = modal.querySelector('.modal-header h3');
                        if (modalTitle) {
                            modalTitle.textContent = `${character.name} - Character Image (Version Selected)`;
                        }
                    });
                }
            } else {
                if (selectBtn) selectBtn.remove();
            }
    };
    
    // Set up version navigation if there are multiple versions
    if (versions.length > 1) {
        versionControls.style.display = 'flex';
        updateVersionDisplay();
    }
    
    // Navigation handlers
    prevBtn.addEventListener('click', () => {
        if (currentVersionIndex > 0) {
            currentVersionIndex--;
            updateVersionDisplay();
        }
    });
    
    nextBtn.addEventListener('click', () => {
        if (currentVersionIndex < versions.length - 1) {
            currentVersionIndex++;
            updateVersionDisplay();
        }
    });
    
    // Focus on prompt textarea
    promptTextarea.focus();
}

// Track selected characters for batch processing
let selectedCharactersForBatch = new Set();
let characterBatchMode = false;

// Show character batch controls
function showCharacterBatchControls() {
    // Check if controls already exist
    let controlsDiv = document.getElementById('character-batch-controls');
    if (controlsDiv) return;
    
    controlsDiv = document.createElement('div');
    controlsDiv.id = 'character-batch-controls';
    controlsDiv.classList.add('batch-controls', 'character-batch-controls');
    
    const modeLabel = document.createElement('span');
    modeLabel.textContent = 'Batch Character Image Generation';
    modeLabel.classList.add('mode-label');
    
    const processBtn = document.createElement('button');
    processBtn.textContent = `Generate Images for ${selectedCharactersForBatch.size} Character(s)`;
    processBtn.classList.add('process-btn');
    processBtn.addEventListener('click', processBatchCharacterImages);
    
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.classList.add('cancel-btn');
    cancelBtn.addEventListener('click', cancelCharacterBatchSelection);
    
    controlsDiv.appendChild(modeLabel);
    controlsDiv.appendChild(processBtn);
    controlsDiv.appendChild(cancelBtn);
    
    const charactersPanel = document.getElementById('characters-panel');
    charactersPanel.insertBefore(controlsDiv, charactersPanel.firstChild);
}

// Hide character batch controls
function hideCharacterBatchControls() {
    const controlsDiv = document.getElementById('character-batch-controls');
    if (controlsDiv) {
        controlsDiv.remove();
    }
}

// Update character batch controls
function updateCharacterBatchControls() {
    const processBtn = document.querySelector('#character-batch-controls .process-btn');
    if (processBtn) {
        processBtn.textContent = `Generate Images for ${selectedCharactersForBatch.size} Character(s)`;
    }
}

// Cancel character batch selection
function cancelCharacterBatchSelection() {
    // Uncheck all checkboxes
    document.querySelectorAll('.character-batch-checkbox').forEach(checkbox => {
        checkbox.checked = false;
    });
    
    selectedCharactersForBatch.clear();
    characterBatchMode = false;
    hideCharacterBatchControls();
}

// Create progress indicator for character batch processing
function createCharacterProgressIndicator(total) {
    const progressDiv = document.createElement('div');
    progressDiv.classList.add('batch-progress');
    progressDiv.innerHTML = `
        <div class="progress-bar">
            <div class="progress-fill" style="width: 0%"></div>
        </div>
        <div class="progress-text">Processing 0 of ${total}</div>
    `;
    
    const controlsDiv = document.getElementById('character-batch-controls');
    controlsDiv.appendChild(progressDiv);
    
    return progressDiv;
}

// Process batch character images
async function processBatchCharacterImages() {
    if (selectedCharactersForBatch.size === 0) return;
    
    // Check if we're using RunPod - if so, skip local model validation
    const currentService = await ipcRenderer.invoke('get-generation-service');
    if (currentService !== 'runpod') {
        // Check if required models are available (only for local generation)
        const requiredModels = ['clip_l', 'ae'];
        const textEncoder = fluxSettings.modelPrecision === 'fp16' ? 't5xxl_fp16' : 't5xxl_fp8';
        const fluxModel = fluxSettings.modelPrecision === 'fp8' ? 'flux_kontext_fp8' : 'flux_kontext';
        
        requiredModels.push(textEncoder, fluxModel);
        
        const missingModels = requiredModels.filter(key => !fluxModelsStatus[key]?.available);
        if (missingModels.length > 0) {
            alert(`Please download required FLUX models first: ${missingModels.map(k => fluxModelsStatus[k]?.name).join(', ')}`);
            return;
        }
    }
    
    const charactersToProcess = Array.from(selectedCharactersForBatch);
    const progressDiv = createCharacterProgressIndicator(charactersToProcess.length);
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < charactersToProcess.length; i++) {
        const characterName = charactersToProcess[i];
        const character = currentCharacters.find(c => c.name === characterName);
        
        if (!character) continue;
        
        updateProgressIndicator(progressDiv, i + 1, charactersToProcess.length, `Generating image for: ${characterName}`);
        
        try {
            const imageDescription = character.imagePrompt || character.baseDescription || character.description;
            const result = await generateFluxCharacterImageBatch(character, imageDescription);
            
            if (result) {
                successCount++;
            } else {
                failCount++;
            }
        } catch (error) {
            console.error(`Error generating image for ${characterName}:`, error);
            failCount++;
        }
    }
    
    removeProgressIndicator(progressDiv);
    
    // Show completion message
    const message = `Batch generation complete! Success: ${successCount}, Failed: ${failCount}`;
    alert(message);
    
    // Refresh characters display
    renderCharacters(currentCharacters);
    
    // Clear selection
    cancelCharacterBatchSelection();
}

// Generate character image for batch processing
async function generateFluxCharacterImageBatch(character, description) {
    try {
        // Get tags for this character
        const charSpecificTags = characterTags[character.name] || [];
        
        // Combine global tags with character-specific tags
        const allTags = [...currentGlobalTags, ...charSpecificTags];
        
        // Build description from parameters if available, otherwise use provided description
        let characterDescription;
        if (character.parameters) {
            characterDescription = buildPromptFromParameters(character);
            console.log(`Batch prompt from parameters for ${character.name}:`, characterDescription);
        }
        
        // Fall back to provided description if parameters didn't generate a prompt
        if (!characterDescription) {
            characterDescription = description || character.imagePrompt || character.baseDescription || character.description;
        }
        
        // Enhanced prompt for character generation with tags
        const photorealismTags = allTags.filter(tag => 
            tag.toLowerCase().includes('photo') || 
            tag.toLowerCase().includes('real') || 
            tag.toLowerCase().includes('not anime') ||
            tag.toLowerCase().includes('not cartoon') ||
            tag.toLowerCase().includes('not illustration')
        );
        const otherTags = allTags.filter(tag => !photorealismTags.includes(tag));
        
        // Build prompt with photorealism emphasis
        let enhancedPrompt = 'RAW photo, photograph, photorealistic, ';
        if (photorealismTags.length > 0) {
            enhancedPrompt += photorealismTags.join(', ') + ', ';
        }
        enhancedPrompt += `${characterDescription}`;
        if (otherTags.length > 0) {
            enhancedPrompt += ', ' + otherTags.join(', ');
        }
        enhancedPrompt += ', professional DSLR photography, 85mm lens, natural lighting, high resolution, detailed skin texture';
        
        console.log(`Batch generating image for ${character.name} with prompt:`, enhancedPrompt);
        
        // Start generation
        const result = await ipcRenderer.invoke('flux-generate-image', {
            prompt: enhancedPrompt,
            settings: fluxSettings
        });
        
        if (result.error) {
            throw new Error(result.error);
        }
        
        // Poll for completion
        const jobId = result.job_id;
        let completed = false;
        let attempts = 0;
        const maxAttempts = 120; // 10 minutes
        
        while (!completed && attempts < maxAttempts) {
            const status = await ipcRenderer.invoke('flux-get-job-status', { jobId });
            
            if (status.error) {
                throw new Error(status.error);
            }
            
            if (status.status === 'completed') {
                completed = true;
                
                // Get the generated image
                const imageBuffer = await ipcRenderer.invoke('flux-get-image', { jobId });
                if (imageBuffer && !imageBuffer.error) {
                    const blob = new Blob([imageBuffer], { type: 'image/png' });
                    
                    // Save the generated image
                    const bookDir = path.join(audiobooksDir, currentBook);
                    const characterImagesDir = path.join(bookDir, 'character_profile_images');
                    
                    // Create the directory if it doesn't exist
                    if (!fs.existsSync(characterImagesDir)) {
                        fs.mkdirSync(characterImagesDir, { recursive: true });
                    }
                    
                    // Generate filename with version number
                    let versionNum = 1;
                    let filename;
                    do {
                        filename = `${character.name.replace(/[^a-zA-Z0-9]/g, '_')}_v${versionNum}.png`;
                        versionNum++;
                    } while (fs.existsSync(path.join(characterImagesDir, filename)));
                    
                    const imagePath = path.join(characterImagesDir, filename);
                    const buffer = Buffer.from(await blob.arrayBuffer());
                    fs.writeFileSync(imagePath, buffer);
                    
                    // Update character photo path
                    character.photo = `character_profile_images/${filename}`;
                    await saveCharactersData();
                    
                    return true;
                }
            } else if (status.status === 'failed') {
                throw new Error(status.error || 'Generation failed');
            }
            
            // Wait before polling again
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }
        
        if (!completed) {
            throw new Error('Generation timed out');
        }
        
    } catch (error) {
        console.error(`Error generating batch image for ${character.name}:`, error);
        return false;
    }
}

// Generate character image for modal without auto-setting it
async function generateFluxCharacterImageForModal(character, description, parentModal, onComplete) {
    // Check if we're using RunPod - if so, skip local model validation
    const currentService = await ipcRenderer.invoke('get-generation-service');
    if (currentService !== 'runpod') {
        // Check if required models are available (only for local generation)
        const requiredModels = ['clip_l', 'ae'];
        const textEncoder = fluxSettings.modelPrecision === 'fp16' ? 't5xxl_fp16' : 't5xxl_fp8';
        const fluxModel = fluxSettings.modelPrecision === 'fp8' ? 'flux_kontext_fp8' : 'flux_kontext';
        
        requiredModels.push(textEncoder, fluxModel);
        
        const missingModels = requiredModels.filter(key => !fluxModelsStatus[key]?.available);
        if (missingModels.length > 0) {
            alert(`Please download required FLUX models first: ${missingModels.map(k => fluxModelsStatus[k]?.name).join(', ')}`);
            return;
        }
    }
    
    // Create a progress overlay within the parent modal
    const progressOverlay = document.createElement('div');
    progressOverlay.className = 'modal-progress-overlay';
    progressOverlay.innerHTML = `
        <div class="modal-progress-content">
            <h3>Generating New Character Portrait</h3>
            <div class="loading-spinner"></div>
            <div class="progress-text">Initializing FLUX generation...</div>
        </div>
    `;
    progressOverlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(255, 255, 255, 0.95);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    `;
    
    const modalContent = parentModal.querySelector('.modal-content');
    modalContent.style.position = 'relative';
    modalContent.appendChild(progressOverlay);
    
    try {
        // Get tags for this character
        const charSpecificTags = characterTags[character.name] || [];
        
        // Combine global tags with character-specific tags
        const allTags = [...currentGlobalTags, ...charSpecificTags];
        
        // Build description from parameters if available, otherwise use provided description
        let characterDescription;
        if (character.parameters) {
            characterDescription = buildPromptFromParameters(character);
            console.log('Modal prompt from parameters:', characterDescription);
        }
        
        // Fall back to provided description if parameters didn't generate a prompt
        if (!characterDescription) {
            characterDescription = description || character.imagePrompt || character.baseDescription || character.description;
        }
        
        // Enhanced prompt for character generation with tags
        const photorealismTags = allTags.filter(tag => 
            tag.toLowerCase().includes('photo') || 
            tag.toLowerCase().includes('real') || 
            tag.toLowerCase().includes('not anime') ||
            tag.toLowerCase().includes('not cartoon') ||
            tag.toLowerCase().includes('not illustration')
        );
        const otherTags = allTags.filter(tag => !photorealismTags.includes(tag));
        
        // Build prompt with photorealism emphasis
        let enhancedPrompt = 'RAW photo, photograph, photorealistic, ';
        if (photorealismTags.length > 0) {
            enhancedPrompt += photorealismTags.join(', ') + ', ';
        }
        enhancedPrompt += `${characterDescription}`;
        if (otherTags.length > 0) {
            enhancedPrompt += ', ' + otherTags.join(', ');
        }
        enhancedPrompt += ', professional DSLR photography, 85mm lens, natural lighting, high resolution, detailed skin texture';
        
        console.log('Generating image with prompt:', enhancedPrompt);
        
        // Start generation
        const result = await ipcRenderer.invoke('flux-generate-image', {
            prompt: enhancedPrompt,
            settings: fluxSettings
        });
        
        if (result.error) {
            throw new Error(result.error);
        }
        
        // Poll for completion
        const jobId = result.job_id;
        let completed = false;
        let attempts = 0;
        const maxAttempts = 120; // 10 minutes
        
        const statusText = progressOverlay.querySelector('.progress-text');
        
        while (!completed && attempts < maxAttempts) {
            const status = await ipcRenderer.invoke('flux-get-job-status', { jobId });
            
            if (status.error) {
                throw new Error(status.error);
            }
            
            if (status.status === 'completed') {
                completed = true;
                
                // Get the generated image
                const imageBuffer = await ipcRenderer.invoke('flux-get-image', { jobId });
                if (imageBuffer && !imageBuffer.error) {
                    const blob = new Blob([imageBuffer], { type: 'image/png' });
                    
                    // Save the generated image to the proper directory structure
                    const bookDir = path.join(audiobooksDir, currentBook);
                    const characterImagesDir = path.join(bookDir, 'character_profile_images');
                    
                    // Create the directory if it doesn't exist
                    if (!fs.existsSync(characterImagesDir)) {
                        fs.mkdirSync(characterImagesDir, { recursive: true });
                    }
                    
                    // Generate filename based on character name
                    const sanitizedName = character.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
                    const timestamp = Date.now();
                    const filename = `${sanitizedName}_${timestamp}.png`;
                    const imagePath = path.join(characterImagesDir, filename);
                    
                    // Save the image blob to file
                    const arrayBuffer = await blob.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    fs.writeFileSync(imagePath, buffer);
                    
                    // Remove progress overlay
                    progressOverlay.remove();
                    
                    // Call the completion callback to update the modal
                    if (onComplete) {
                        onComplete();
                    }
                    
                    statusText.textContent = 'Image generated successfully!';
                }
            } else if (status.status === 'failed') {
                throw new Error(status.error || 'Generation failed');
            } else {
                statusText.textContent = `Generating... (${Math.floor((attempts / maxAttempts) * 100)}%)`;
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        }
        
        if (!completed) {
            throw new Error('Generation timeout');
        }
        
    } catch (error) {
        console.error('Error generating character image:', error);
        alert(`Error generating image: ${error.message}`);
        progressOverlay.remove();
    }
}

// Helper function to build prompt from character parameters
function buildPromptFromParameters(character) {
    const params = character.parameters;
    if (!params) return null;
    
    let promptParts = [];
    
    // CRITICAL: Start with historical context to set the scene
    if (character.timePeriod && character.location) {
        promptParts.push(`${character.timePeriod} setting`);
        promptParts.push(`${character.location}`);
        promptParts.push('historically accurate');
        
        // Add specific era indicators
        if (character.timePeriod.toLowerCase().includes('ancient rome')) {
            promptParts.push('Roman citizen');
            promptParts.push('classical antiquity');
            promptParts.push('no modern clothing');
            promptParts.push('toga era');
        }
    }
    
    // Identity
    if (params.identity) {
        const { role, age, gender } = params.identity;
        if (age && gender) {
            promptParts.push(`${age} year old ${gender}`);
        } else if (gender) {
            promptParts.push(gender);
        }
        if (role) {
            promptParts.push(role);
        }
    }
    
    // Physical Build
    if (params.physicalBuild) {
        const { height, build, posture } = params.physicalBuild;
        if (height) promptParts.push(`height: ${height}`);
        if (build) promptParts.push(`body build: ${build}`);
        if (posture) promptParts.push(`posture: ${posture}`);
    }
    
    // Facial Features - Be explicit about what each descriptor applies to
    if (params.facialFeatures) {
        const { skinTone, faceShape, eyes, hair, facialHair, distinctiveFeatures } = params.facialFeatures;
        if (skinTone) promptParts.push(`skin tone: ${skinTone}`);
        if (faceShape) promptParts.push(`face shape: ${faceShape}`);
        if (eyes) promptParts.push(`eyes: ${eyes}`);
        if (hair) promptParts.push(`hair: ${hair}`);
        if (facialHair && facialHair !== 'none') promptParts.push(`facial hair: ${facialHair}`);
        if (distinctiveFeatures && distinctiveFeatures !== 'none') promptParts.push(`distinctive features: ${distinctiveFeatures}`);
    }
    
    // Attire
    if (params.attire) {
        const { headwear, upperBody, lowerBody, footwear, accessories, clothingStyle, clothingColors } = params.attire;
        
        // Add period-specific clothing disclaimers
        if (character.timePeriod && character.timePeriod.toLowerCase().includes('ancient rome')) {
            promptParts.push('authentic Roman clothing only');
            promptParts.push('no buttons');
            promptParts.push('no zippers');
            promptParts.push('no pockets');
            promptParts.push('draped fabric');
        }
        
        if (headwear && headwear !== 'none') promptParts.push(`wearing ${headwear}`);
        if (upperBody) promptParts.push(`wearing ${upperBody}`);
        if (lowerBody) promptParts.push(`wearing ${lowerBody}`);
        if (footwear) promptParts.push(`wearing ${footwear}`);
        if (accessories && accessories !== 'none') promptParts.push(`with ${accessories}`);
        if (clothingStyle) promptParts.push(`${clothingStyle} style clothing`);
        if (clothingColors) promptParts.push(`${clothingColors} colored clothes`);
    }
    
    // Personality (for pose/expression)
    if (params.personality) {
        const { demeanor, traits } = params.personality;
        if (demeanor) promptParts.push(`expression: ${demeanor}`);
    }
    
    // Join all parts into a coherent prompt
    return promptParts.join(', ');
}

// Generate character image with FLUX
async function generateFluxCharacterImage(character, subCharacter, description, imageElement) {
    // Check if we're using RunPod - if so, skip local model validation
    const currentService = await ipcRenderer.invoke('get-generation-service');
    if (currentService !== 'runpod') {
        // Check if required models are available (only for local generation)
        const requiredModels = ['clip_l', 'ae'];
        const textEncoder = fluxSettings.modelPrecision === 'fp16' ? 't5xxl_fp16' : 't5xxl_fp8';
        const fluxModel = fluxSettings.modelPrecision === 'fp8' ? 'flux_kontext_fp8' : 'flux_kontext';
        
        requiredModels.push(textEncoder, fluxModel);
        
        const missingModels = requiredModels.filter(key => !fluxModelsStatus[key]?.available);
        if (missingModels.length > 0) {
            alert(`Please download required FLUX models first: ${missingModels.map(k => fluxModelsStatus[k]?.name).join(', ')}`);
            return;
        }
    }
    
    // Create a modal for generation progress
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <h2>Generating Character Portrait</h2>
            <p>Creating portrait for ${subCharacter ? subCharacter.name : character.name}</p>
            <div class="flux-generating">
                <div class="loading-spinner"></div>
                <div class="flux-generating-text">Initializing FLUX generation...</div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    modal.style.display = 'block';
    
    try {
        // Get tags for this character
        const charName = subCharacter ? subCharacter.name : character.name;
        const charSpecificTags = characterTags[charName] || [];
        
        // Combine global tags with character-specific tags
        const allTags = [...currentGlobalTags, ...charSpecificTags];
        const tagsString = allTags.length > 0 ? ', ' + allTags.join(', ') : '';
        
        // Build description from parameters if available, otherwise use provided description
        let characterDescription;
        if (character.parameters) {
            characterDescription = buildPromptFromParameters(character);
            console.log('Built prompt from parameters:', characterDescription);
        }
        
        // Fall back to provided description if parameters didn't generate a prompt
        if (!characterDescription) {
            characterDescription = description || character.imagePrompt || character.baseDescription || character.description;
        }
        
        // Enhanced prompt for character generation with tags
        // Structure prompt to emphasize photorealism first
        const photorealismTags = allTags.filter(tag => 
            tag.toLowerCase().includes('photo') || 
            tag.toLowerCase().includes('real') || 
            tag.toLowerCase().includes('not anime') ||
            tag.toLowerCase().includes('not cartoon') ||
            tag.toLowerCase().includes('not illustration')
        );
        const otherTags = allTags.filter(tag => !photorealismTags.includes(tag));
        
        // Build prompt with photorealism emphasis
        let enhancedPrompt = 'RAW photo, photograph, photorealistic, ';
        if (photorealismTags.length > 0) {
            enhancedPrompt += photorealismTags.join(', ') + ', ';
        }
        enhancedPrompt += `${characterDescription}`;
        if (otherTags.length > 0) {
            enhancedPrompt += ', ' + otherTags.join(', ');
        }
        enhancedPrompt += ', professional DSLR photography, 85mm lens, natural lighting, high resolution, detailed skin texture';
        
        console.log('Generating image with prompt:', enhancedPrompt); // Debug log
        
        // Start generation
        const result = await ipcRenderer.invoke('flux-generate-image', {
            prompt: enhancedPrompt,
            settings: fluxSettings
        });
        
        if (result.error) {
            throw new Error(result.error);
        }
        
        // Poll for completion
        const jobId = result.job_id;
        let completed = false;
        let attempts = 0;
        const maxAttempts = 120; // 10 minutes
        
        const statusText = modal.querySelector('.flux-generating-text');
        
        while (!completed && attempts < maxAttempts) {
            const status = await ipcRenderer.invoke('flux-get-job-status', { jobId });
            
            if (status.error) {
                throw new Error(status.error);
            }
            
            if (status.status === 'completed') {
                completed = true;
                
                // Get the generated image
                const imageBuffer = await ipcRenderer.invoke('flux-get-image', { jobId });
                if (imageBuffer && !imageBuffer.error) {
                    const blob = new Blob([imageBuffer], { type: 'image/png' });
                    const imageUrl = URL.createObjectURL(blob);
                    
                    // Update the character image
                    imageElement.src = imageUrl;
                    
                    // Save the generated image to the proper directory structure
                    const bookDir = path.join(audiobooksDir, currentBook);
                    const characterImagesDir = path.join(bookDir, 'character_profile_images');
                    
                    // Create the directory if it doesn't exist
                    if (!fs.existsSync(characterImagesDir)) {
                        fs.mkdirSync(characterImagesDir, { recursive: true });
                    }
                    
                    // Generate filename based on character name
                    const characterName = subCharacter ? subCharacter.name : character.name;
                    const sanitizedName = characterName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
                    const timestamp = Date.now();
                    const filename = subCharacter ? 
                        `${sanitizedName}_${subCharacter.id}_${timestamp}.png` : 
                        `${sanitizedName}_${timestamp}.png`;
                    const imagePath = path.join(characterImagesDir, filename);
                    
                    // Save the image blob to file
                    const arrayBuffer = await blob.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    fs.writeFileSync(imagePath, buffer);
                    
                    // Update character data with the new image path
                    const charactersJsonPath = getCharactersFilePath(currentBook);
                    let characters = JSON.parse(fs.readFileSync(charactersJsonPath, 'utf-8'));
                    
                    // Find the character and update the photo path
                    const charIndex = characters.findIndex(c => c.name === character.name);
                    if (charIndex !== -1) {
                        if (subCharacter) {
                            // Update sub-characteristic photo
                            const subCharIndex = characters[charIndex].subCharacteristics.findIndex(
                                sc => sc.id === subCharacter.id
                            );
                            if (subCharIndex !== -1) {
                                characters[charIndex].subCharacteristics[subCharIndex].photo = 
                                    path.join('character_profile_images', filename);
                            }
                        } else {
                            // Update main character photo
                            characters[charIndex].photo = path.join('character_profile_images', filename);
                        }
                        
                        // Save updated character data
                        fs.writeFileSync(charactersJsonPath, JSON.stringify(characters, null, 2));
                        
                        // Reload characters to update the display
                        loadCharacters(currentBook);
                        
                        // Close the modal
                        modal.remove();
                        
                        // Also refresh the Audio Books display to show the new character image
                        const bookItems = document.querySelectorAll('#book-list .book-item');
                        bookItems.forEach(bookItem => {
                            if (bookItem.textContent === currentBook) {
                                bookItem.click(); // This will reload the chapters and character displays
                            }
                        });
                    }
                    
                    statusText.textContent = 'Image generated successfully!';
                    setTimeout(() => {
                        document.body.removeChild(modal);
                    }, 1500);
                }
            } else if (status.status === 'failed') {
                throw new Error(status.error || 'Generation failed');
            } else {
                statusText.textContent = `Generating... (${Math.floor((attempts / maxAttempts) * 100)}%)`;
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        }
        
        if (!completed) {
            throw new Error('Generation timeout');
        }
        
    } catch (error) {
        console.error('Error generating character image:', error);
        alert(`Error generating image: ${error.message}`);
        document.body.removeChild(modal);
    }
}

// Listen for model download progress
ipcRenderer.on('flux-download-progress', (event, { modelKey, status }) => {
    console.log('Download progress update:', modelKey, status);
    
    if (!fluxModelsStatus[modelKey]) {
        console.error('Model not found in status:', modelKey);
        return;
    }
    
    if (status.error) {
        // Download failed
        fluxModelsStatus[modelKey].downloading = false;
        fluxModelsStatus[modelKey].progress = 0;
        alert(`Error downloading ${fluxModelsStatus[modelKey].name}: ${status.error}`);
        renderFluxModelsList();
    } else if (status.completed || status.progress === 100) {
        // Download complete
        fluxModelsStatus[modelKey].available = true;
        fluxModelsStatus[modelKey].downloading = false;
        fluxModelsStatus[modelKey].progress = 100;
        renderFluxModelsList();
        // Refresh models status to confirm
        updateFluxModelsStatus();
    } else if (status.downloading !== false) {
        // Update progress without re-rendering entire list
        fluxModelsStatus[modelKey].downloading = true;
        fluxModelsStatus[modelKey].progress = status.progress || 0;
        
        // Update only the progress bar for this specific model
        const modelDiv = document.getElementById(`flux-model-${modelKey}`);
        if (modelDiv) {
            const progressBar = modelDiv.querySelector('.flux-progress-fill');
            const progressText = modelDiv.querySelector('.flux-progress-text');
            if (progressBar && progressText) {
                progressBar.style.width = `${status.progress || 0}%`;
                progressText.textContent = `Downloading... ${status.progress || 0}%`;
            }
        }
    }
});

// Update character selects in Kontext section
function updateKontextCharacterSelects() {
    const char1Select = document.getElementById('kontext-char1');
    const char2Select = document.getElementById('kontext-char2');
    
    // Clear existing options
    char1Select.innerHTML = '<option value="">Select Character 1</option>';
    char2Select.innerHTML = '<option value="">Select Character 2</option>';
    
    // Add character options
    currentCharacters.forEach((character, index) => {
        const option1 = document.createElement('option');
        option1.value = index;
        option1.textContent = character.name;
        char1Select.appendChild(option1);
        
        const option2 = document.createElement('option');
        option2.value = index;
        option2.textContent = character.name;
        char2Select.appendChild(option2);
    });
}

// Update character preview in Kontext section
function updateKontextCharacterPreview(characterIndex, previewDivId) {
    const previewDiv = document.getElementById(previewDivId);
    
    if (!characterIndex || characterIndex === '') {
        previewDiv.innerHTML = '';
        return;
    }
    
    const character = currentCharacters[parseInt(characterIndex)];
    if (!character) {
        previewDiv.innerHTML = '';
        return;
    }
    
    // Check if character has a photo
    let imageSrc;
    if (character.photo && character.photo !== 'placeholder.png') {
        // Use the saved character image from the book directory
        const bookDir = path.join(audiobooksDir, currentBook);
        imageSrc = path.join(bookDir, character.photo);
        
        previewDiv.innerHTML = `
            <div class="character-preview-img">
                <img src="${imageSrc}" alt="${character.name}" />
            </div>
        `;
    } else {
        // Show placeholder if no image
        previewDiv.innerHTML = `
            <div class="character-preview-placeholder">
                <div class="placeholder-text">No image</div>
                <div class="character-name">${character.name}</div>
            </div>
        `;
    }
}

// Lazy initialization for FLUX panel
async function ensureFluxInitialized(showSetupIfNeeded = true) {
    if (!fluxInitialized) {
        await initializeFluxPanel(showSetupIfNeeded);
    }
}

// Add click listener to FLUX panel for lazy initialization
document.addEventListener('DOMContentLoaded', () => {
    // Update FLUX service status immediately on page load
    updateFluxServiceStatus();
    // Continue checking status periodically
    setInterval(updateFluxServiceStatus, 10000); // Check every 10 seconds
    
    // Set up service toggle button immediately (needs to work without full initialization)
    const serviceToggleBtn = document.getElementById('flux-service-toggle');
    if (serviceToggleBtn) {
        serviceToggleBtn.addEventListener('click', async (e) => {
            const btn = e.target;
            const isRunning = btn.textContent === 'Stop Service' || btn.textContent === 'Stop ComfyUI';
            
            btn.disabled = true;
            btn.textContent = isRunning ? 'Stopping...' : 'Starting...';
            
            if (isRunning) {
                // Stop service
                const result = await ipcRenderer.invoke('flux-stop-service');
                if (result.error) {
                    alert(`Error stopping service: ${result.error}`);
                }
            } else {
                // Start service - this will show the setup modal
                await showFluxSetupModal();
            }
            
            // Update status
            await updateFluxServiceStatus();
        });
    }
    
    const fluxPanel = document.getElementById('flux-panel');
    if (fluxPanel) {
        fluxPanel.addEventListener('click', async (e) => {
            // Don't trigger initialization if clicking the service toggle button
            if (e.target.id === 'flux-service-toggle') return;
            
            // Initialize FLUX when user interacts with the panel
            await ensureFluxInitialized(true);
        }, { once: true }); // Only run once
    }
    
    // Also add listener to test generate button for lazy init
    const testGenerateBtn = document.getElementById('flux-test-generate');
    if (testGenerateBtn) {
        testGenerateBtn.addEventListener('click', async () => {
            await ensureFluxInitialized(true);
        }, { once: true });
    }
});

// Initialize FLUX panel on load
// Initialize with showSetupIfNeeded=false to prevent automatic setup prompt
initializeFluxPanel(false);

// Update models status periodically
setInterval(updateFluxModelsStatus, 30000); // Every 30 seconds

// Whisper service status tracking
let whisperServiceStatus = false;

// Update AI Services status indicator
async function updateAIServicesStatus() {
    const statusIndicator = document.querySelector('.ai-status-indicator');
    if (!statusIndicator) {
        console.error('AI status indicator not found');
        return;
    }
    
    try {
        const availability = await whisperClient.checkAvailability();
        whisperServiceStatus = availability.service;
        
        console.log('AI Service status:', availability); // Debug log
        
        // Remove any inline styles that might override the CSS
        statusIndicator.style.removeProperty('background');
        statusIndicator.style.removeProperty('background-color');
        
        if (availability.service) {
            statusIndicator.className = 'ai-status-indicator running';
        } else {
            statusIndicator.className = 'ai-status-indicator stopped';
        }
        
        // Update transcribe button states
        updateTranscribeButtonStates();
    } catch (error) {
        console.error('Error updating AI services status:', error);
        whisperServiceStatus = false;
        statusIndicator.className = 'ai-status-indicator stopped';
        updateTranscribeButtonStates();
    }
}

// Update all transcribe buttons based on service status
function updateTranscribeButtonStates() {
    const transcribeButtons = document.querySelectorAll('.transcribe-btn');
    transcribeButtons.forEach(button => {
        // Check if button is already disabled due to existing transcription
        const chapterItem = button.closest('.chapter-item');
        if (!chapterItem) return;
        
        const chapterTitle = chapterItem.querySelector('.chapter-title')?.textContent;
        if (!chapterTitle) return;
        
        const bookContainer = button.closest('.book-container');
        const bookItem = bookContainer?.querySelector('.book-item');
        const bookName = bookItem?.textContent || currentBook;
        
        const transcriptionFilePath = path.join(audiobooksDir, bookName, `${chapterTitle}.txt`);
        const hasTranscription = fs.existsSync(transcriptionFilePath);
        
        if (hasTranscription) {
            // Keep disabled if transcription exists
            button.classList.add('disabled');
            button.disabled = true;
            button.title = 'Transcription already exists';
        } else if (!whisperServiceStatus) {
            // Disable if service is not available
            button.classList.add('disabled');
            button.disabled = true;
            button.title = 'AI Services not available';
        } else {
            // Enable if service is available and no transcription exists
            button.classList.remove('disabled');
            button.disabled = false;
            button.title = 'Click to transcribe this chapter. Click on multiple chapters to batch transcribe.';
        }
    });
}

// Initialize AI Services on page load
document.addEventListener('DOMContentLoaded', () => {
    // Small delay to ensure all elements are properly loaded
    setTimeout(() => {
        // Update AI Services status immediately
        updateAIServicesStatus();
        // Continue checking status periodically
        setInterval(updateAIServicesStatus, 10000); // Check every 10 seconds
    }, 100);
    
    // AI Services button click handler
    const aiServicesBtn = document.getElementById('ai-services-btn');
    if (aiServicesBtn) {
        aiServicesBtn.addEventListener('click', async () => {
            // Show Whisper setup modal
            whisperClient.showSetupModal();
        });
    }
});
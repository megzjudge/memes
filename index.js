// Error Logger: Collects console errors/logs and auto-downloads a file after 5s (or on manual trigger)
(function() {
    let logEntries = [];
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;

    // Override console methods to capture
    console.error = function(...args) {
        logEntries.push({ type: 'ERROR', timestamp: new Date().toISOString(), message: args.join(' ') });
        originalConsoleError.apply(console, args);
    };
    console.log = function(...args) {
        logEntries.push({ type: 'LOG', timestamp: new Date().toISOString(), message: args.join(' ') });
        originalConsoleLog.apply(console, args);
    };
    console.warn = function(...args) {
        logEntries.push({ type: 'WARN', timestamp: new Date().toISOString(), message: args.join(' ') });
        originalConsoleWarn.apply(console, args);
    };

    // Function to download logs as TXT
    function downloadLogs() {
        const logText = logEntries.map(entry => `[${entry.timestamp}] ${entry.type}: ${entry.message}`).join('\n');
        const blob = new Blob([logText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `js-errors-${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log('Error log downloaded! Check your Downloads folder.');
    }

    // Auto-download after 5 seconds
    setTimeout(downloadLogs, 5000);

    // Manual button (uncommented for easy access)
    const triggerBtn = document.createElement('button');
    triggerBtn.textContent = 'Download Error Log';
    triggerBtn.style.position = 'fixed'; 
    triggerBtn.style.top = '10px'; 
    triggerBtn.style.right = '10px'; 
    triggerBtn.style.zIndex = '9999';
    triggerBtn.style.background = '#ff4444'; 
    triggerBtn.style.color = 'white'; 
    triggerBtn.style.padding = '5px 10px'; 
    triggerBtn.style.border = 'none'; 
    triggerBtn.style.borderRadius = '3px'; 
    triggerBtn.style.cursor = 'pointer';
    triggerBtn.onclick = downloadLogs;
    document.body.appendChild(triggerBtn);
})();

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded - starting MBTI Meme init');

    const sections = document.querySelectorAll('.content-section');
    console.log(`Found ${sections.length} sections`);

    const containers = {
        type: document.getElementById('type-buttons'),
        meme: document.getElementById('meme-buttons'),
        keywords: document.getElementById('keywords-buttons')
    };
    console.log('Containers:', containers);

    const types = new Set();
    const keywordsSet = new Set();
    const memes = new Set();

    // Fetch stats from Worker
    async function fetchMemeStats(memeId) {
        try {
            const response = await fetch(`https://imgflip-stats.your-account.workers.dev/stats?memeId=${memeId}`);
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'API returned failure');
            }
            return data.data;
        } catch (error) {
            console.error(`Error fetching stats for meme ${memeId}:`, error);
            return { views: 0, upvotes: 0, date: 'N/A' };
        }
    }

    // Update sections with stats buttons
    async function updateMemeStats() {
        console.log('Starting meme stats update');
        const fetchTasks = [];

        sections.forEach(section => {
            const linkEl = section.querySelector('.image-links a[href]');
            if (linkEl && linkEl.href) {
                const urlMatch = linkEl.href.match(/imgflip\.com\/i\/([a-zA-Z0-9]+)/);
                if (urlMatch) {
                    const memeId = urlMatch[1];
                    section.dataset.memeId = memeId;
                    console.log(`Matched memeId: ${memeId}`);

                    const buttonsContainer = section.querySelector('.section-buttons');
                    if (buttonsContainer) {
                        const loader = document.createElement('div');
                        loader.classList.add('loader');
                        buttonsContainer.appendChild(loader);
                        console.log('Added loader for', memeId);

                        fetchTasks.push(
                            fetchMemeStats(memeId).then(stats => ({ stats, buttonsContainer, loader }))
                        );
                    }
                }
            }
        });

        if (fetchTasks.length > 0) {
            try {
                const results = await Promise.all(fetchTasks);
                console.log(`Fetched stats for ${results.length} memes`);
                results.forEach(({ stats, buttonsContainer, loader }) => {
                    if (buttonsContainer.contains(loader)) {
                        buttonsContainer.removeChild(loader);
                    }

                    const statsButtons = [
                        { label: `Views: ${stats.views.toLocaleString()}`, type: 'views' },
                        { label: `Upvotes: ${stats.upvotes}`, type: 'upvotes' },
                        { label: `Created: ${stats.date !== 'N/A' ? new Date(stats.date).toLocaleDateString('en-AU') : 'N/A'}`, type: 'date' }
                    ];

                    statsButtons.forEach(stat => {
                        const button = document.createElement('button');
                        button.textContent = stat.label;
                        button.dataset.statType = stat.type;
                        button.classList.add('stat-button');
                        button.disabled = true;
                        buttonsContainer.appendChild(button);
                    });
                });
            } catch (err) {
                console.error('Error in updateMemeStats:', err);
            }
        } else {
            console.log('No valid meme links found for stats');
        }
    }

    // Defined initializeAccordion function (to fix the ReferenceError)
    function initializeAccordion() {
        console.log('Initializing accordions');
        sections.forEach((section) => {
            const infoBox = section.querySelector('.info-box');
            const panel = section.querySelector('.image-container');
            if (infoBox && panel) {
                const titleRow = section.querySelector('.title-row');
                if (titleRow) {
                    const imageLinks = titleRow.querySelector('.image-links');
                    let arrow = titleRow.querySelector('.arrow');
                    if (!arrow) {
                        arrow = document.createElement('span');
                        arrow.classList.add('arrow');
                        arrow.textContent = '+';
                        if (imageLinks) {
                            titleRow.insertBefore(arrow, imageLinks);
                        } else {
                            titleRow.appendChild(arrow);
                        }
                    }

                    // Remove existing listener to avoid duplicates
                    infoBox.removeEventListener('click', handleAccordionClick);
                    infoBox.addEventListener('click', handleAccordionClick);

                    function handleAccordionClick(e) {
                        if (e.target.closest('button') || e.target.closest('a')) return;
                        infoBox.classList.toggle('active');
                        const isActive = infoBox.classList.contains('active');
                        arrow.textContent = isActive ? '−' : '+';
                        panel.style.display = isActive ? 'block' : 'none';
                    }
                }
                panel.style.display = 'none'; // Start collapsed
            }
        });
    }

    // Process sections for filters and data collection
    sections.forEach((section) => {
        // Collect filter data
        if (section.dataset.type) {
            section.dataset.type.toLowerCase().trim().split(/[\s,]+/).forEach(t => {
                const trimmedT = t.trim();
                if (trimmedT) types.add(trimmedT === 'non-mbti' ? 'non-mbti' : trimmedT);
            });
        }
        if (section.dataset.keywords) {
            section.dataset.keywords.toLowerCase().trim().split(',').map(kw => kw.trim()).filter(kw => kw).forEach(kw => keywordsSet.add(kw));
        }
        if (section.dataset.meme) {
            const memeStr = section.dataset.meme.toLowerCase().trim();
            if (memeStr) memes.add(memeStr);
        }

        // Add per-section filter buttons
        const buttonsContainer = section.querySelector('.section-buttons');
        if (buttonsContainer) {
            const buttonData = [];
            if (section.dataset.type) {
                section.dataset.type.toLowerCase().trim().split(/[\s,]+/).forEach(t => {
                    const trimmedT = t.trim();
                    if (trimmedT) {
                        const value = trimmedT === 'non-mbti' ? 'non-mbti' : trimmedT;
                        const label = value === 'non-mbti' ? 'Non-MBTI' : value.toUpperCase();
                        buttonData.push({ type: 'type', value, label: `type: ${label}` });
                    }
                });
            }
            if (section.dataset.meme) {
                const value = section.dataset.meme.toLowerCase().trim();
                if (value) buttonData.push({ type: 'meme', value, label: value });
            }
            if (section.dataset.keywords) {
                section.dataset.keywords.toLowerCase().trim().split(',').map(kw => kw.trim()).filter(kw => kw).forEach(kw => {
                    buttonData.push({ type: 'keywords', value: kw, label: kw });
                });
            }

            buttonData.forEach(data => {
                const button = document.createElement('button');
                button.textContent = data.label;
                button.dataset.filterType = data.type;
                button.dataset.value = data.value;
                button.addEventListener('click', () => filterSections(data.type, data.value));
                buttonsContainer.appendChild(button);
            });
        }
    });

    // Force-add all MBTI types
    const mbtiTypes = new Set(['estp', 'istp', 'esfp', 'isfp', 'estj', 'istj', 'esfj', 'isfj', 'enfp', 'infp', 'enfj', 'infj', 'entj', 'intj', 'entp', 'intp']);
    mbtiTypes.forEach(t => types.add(t));
    types.add('non-mbti');
    types.add('all');

    const sortedTypes = [...types].sort();
    const sortedKeywords = [...keywordsSet].sort();
    const sortedMemes = [...memes].sort();

    function createButtons(container, values, filterType) {
        if (container) {
            const allButton = document.createElement('button');
            allButton.textContent = 'all';
            allButton.dataset.filterType = filterType;
            allButton.dataset.value = 'all';
            allButton.addEventListener('click', () => filterSections(filterType, 'all'));
            container.appendChild(allButton);

            values.forEach(value => {
                if (value && typeof value === 'string' && value !== 'all') {
                    const button = document.createElement('button');
                    const displayText = filterType === 'type' ? (value === 'non-mbti' ? 'Non-MBTI' : value.toUpperCase()) : value;
                    button.textContent = displayText;
                    button.dataset.filterType = filterType;
                    button.dataset.value = value;
                    button.addEventListener('click', () => filterSections(filterType, value));
                    container.appendChild(button);
                }
            });
            console.log(`Created ${values.length} buttons for ${filterType}`);
        }
    }

    createButtons(containers.type, sortedTypes, 'type');
    createButtons(containers.meme, sortedMemes, 'meme');
    createButtons(containers.keywords, sortedKeywords, 'keywords');

    let currentFilters = { type: 'all', meme: 'all', keywords: 'all' };

    function filterSections(filterType, value) {
        console.log(`Filtering ${filterType} with value: ${value}`);
        currentFilters[filterType] = value === currentFilters[filterType] ? 'all' : value;

        // Update button states
        document.querySelectorAll(`button[data-filter-type="${filterType}"]`).forEach(btn => {
            const btnValue = btn.dataset.value;
            const isActive = btnValue === currentFilters[filterType] && currentFilters[filterType] !== 'all';
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });

        // Filter sections
        sections.forEach(section => {
            section.classList.remove('hidden');
            const activeFilter = Object.entries(currentFilters).find(([key, val]) => val !== 'all' && key === filterType);
            let matches = !activeFilter;

            if (activeFilter) {
                const [, activeValue] = activeFilter;
                let sectionValue = section.dataset[filterType] ? section.dataset[filterType].toLowerCase().trim() : '';

                if (filterType === 'type') {
                    const typesArray = sectionValue.split(/[\s,]+/);
                    if (activeValue === 'non-mbti') {
                        matches = !typesArray.some(t => mbtiTypes.has(t.trim()));
                    } else {
                        matches = typesArray.includes(activeValue);
                    }
                } else if (filterType === 'meme') {
                    matches = sectionValue === activeValue;
                } else if (filterType === 'keywords') {
                    const keywordsArray = sectionValue.split(',').map(kw => kw.trim()).filter(kw => kw);
                    matches = keywordsArray.some(kw => kw.includes(activeValue));
                }
            }

            section.classList.toggle('hidden', !matches);
        });
    }

    // Initialize everything
    try {
        Object.keys(currentFilters).forEach(filter => filterSections(filter, 'all'));
        initializeAccordion();  // This was the missing piece—now defined!
        updateMemeStats();
        console.log('MBTI Meme init complete');
    } catch (err) {
        console.error('Init error:', err);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    console.log('Script loaded at', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }));

    const sections = document.querySelectorAll('.content-section');
    console.log('Found sections:', sections.length, 'Details:', Array.from(sections).map(s => ({
        outerHTML: s.outerHTML.slice(0, 100),
        dataset: s.dataset
    })));

    const containers = {
        type: document.getElementById('type-buttons'),
        meme: document.getElementById('meme-buttons'),
        keywords: document.getElementById('keywords-buttons')
    };
    console.log('Container status:', Object.fromEntries(Object.entries(containers).map(([k, v]) => [k, v ? 'Present' : 'Missing'])));

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
        for (const section of sections) {
            const linkEl = section.querySelector('.image-links a[href]');
            if (linkEl && linkEl.href) {
                const urlMatch = linkEl.href.match(/imgflip\.com\/i\/([a-zA-Z0-9]+)/);
                if (urlMatch) {
                    const memeId = urlMatch[1];
                    section.dataset.memeId = memeId;
                    console.log(`Extracted ID ${memeId} for section:`, section.querySelector('h3').textContent);

                    const stats = await fetchMemeStats(memeId);
                    const buttonsContainer = section.querySelector('.section-buttons');

                    // Create stats buttons
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
                        button.disabled = true; // Read-only
                        button.addEventListener('click', () => console.log(`Stat clicked: ${stat.type} = ${button.textContent}`));
                        buttonsContainer.appendChild(button);
                    });
                } else {
                    console.warn('No valid ID in URL:', linkEl.href);
                }
            } else {
                console.log('No Imgflip link found for section:', section.querySelector('h3').textContent);
            }
        }
    }

    sections.forEach((section, idx) => {
        console.log(`Processing section ${idx + 1} data:`, section.dataset);
        if (section.dataset.type) {
            const typeStr = section.dataset.type.toString().toLowerCase().trim();
            typeStr.split(/[\s,]+/).forEach(t => {
                const trimmedT = t.trim();
                if (trimmedT) {
                    const normalizedT = trimmedT.toLowerCase() === 'non-mbti' ? 'non-mbti' : trimmedT;
                    types.add(normalizedT);
                }
            });
        }
        if (section.dataset.keywords) {
            const keywordsStr = section.dataset.keywords.toString().toLowerCase().trim();
            const keywordsArray = keywordsStr.split(',')
                .map(kw => kw.trim())
                .filter(kw => kw.length > 0);
            keywordsArray.forEach(kw => keywordsSet.add(kw));
        }
        if (section.dataset.meme) {
            const memeStr = section.dataset.meme.toString().toLowerCase().trim();
            if (memeStr) memes.add(memeStr);
        }

        const buttonsContainer = section.querySelector('.section-buttons');
        if (buttonsContainer) {
            const buttonData = [];
            if (section.dataset.type) {
                const typeStr = section.dataset.type.toLowerCase().trim();
                typeStr.split(/[\s,]+/).forEach(t => {
                    const tTrimmed = t.trim();
                    if (tTrimmed) {
                        const typeLower = tTrimmed.toLowerCase() === 'non-mbti' ? 'non-mbti' : tTrimmed.toLowerCase();
                        const displayLabel = typeLower === 'non-mbti' ? 'Non-MBTI' : typeLower.toUpperCase();
                        buttonData.push({ type: 'type', value: typeLower, label: `type: ${displayLabel}` });
                    }
                });
            }
            if (section.dataset.meme) {
                const memeStr = section.dataset.meme.toLowerCase().trim();
                if (memeStr) {
                    buttonData.push({ type: 'meme', value: memeStr, label: memeStr });
                }
            }
            if (section.dataset.keywords) {
                const keywordsStr = section.dataset.keywords.toLowerCase().trim();
                const keywordsArray = keywordsStr.split(',')
                    .map(kw => kw.trim())
                    .filter(kw => kw.length > 0);
                keywordsArray.forEach(kw => {
                    if (kw) {
                        buttonData.push({ type: 'keywords', value: kw, label: kw });
                    }
                });
            }

            if (buttonData.length) {
                buttonData.forEach(data => {
                    const button = document.createElement('button');
                    button.textContent = data.label;
                    button.dataset.filterType = data.type;
                    button.dataset.value = data.value;
                    button.addEventListener('click', () => filterSections(data.type, data.value));
                    buttonsContainer.appendChild(button);
                });
            }
        }
    });

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
                if (value && typeof value === 'string') {
                    const button = document.createElement('button');
                    let displayText;
                    if (filterType === 'type') {
                        if (value === 'all') {
                            displayText = 'all';
                        } else if (value === 'non-mbti') {
                            displayText = 'Non-MBTI';
                        } else {
                            displayText = value.toUpperCase();
                        }
                    } else {
                        displayText = value;
                    }
                    button.textContent = displayText;
                    button.dataset.filterType = filterType;
                    button.dataset.value = value;
                    button.addEventListener('click', () => filterSections(filterType, value));
                    container.appendChild(button);
                }
            });
        }
    }

    createButtons(containers.type, sortedTypes, 'type');
    createButtons(containers.meme, sortedMemes, 'meme');
    createButtons(containers.keywords, sortedKeywords, 'keywords');

    let currentFilters = {
        type: 'all',
        meme: 'all',
        keywords: 'all'
    };

    function filterSections(filterType, value) {
        console.log(`Filtering ${filterType} with value:`, value);
        currentFilters[filterType] = value === currentFilters[filterType] ? 'all' : value;
        console.log('Current filters:', currentFilters);

        document.querySelectorAll(`button[data-filter-type="${filterType}"]`).forEach(btn => {
            const btnValue = btn.dataset.value;
            const isActive = btnValue === currentFilters[filterType] && currentFilters[filterType] !== 'all';
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive);
        });

        sections.forEach(section => {
            section.classList.remove('hidden');
            const activeFilter = Object.entries(currentFilters).find(([key, val]) => val !== 'all');
            let matches = !activeFilter;

            if (activeFilter) {
                const [activeType, activeValue] = activeFilter;
                let sectionValue;

                if (activeType === 'type') {
                    sectionValue = section.dataset.type ? section.dataset.type.toLowerCase().trim() : '';
                    if (activeValue === 'non-mbti') {
                        matches = !sectionValue.split(/[\s,]+/).some(t => mbtiTypes.has(t));
                    } else if (activeValue === 'all') {
                        matches = true;
                    } else {
                        matches = sectionValue.split(/[\s,]+/).includes(activeValue);
                    }
                } else if (activeType === 'meme') {
                    sectionValue = section.dataset.meme ? section.dataset.meme.toLowerCase().trim() : '';
                    matches = sectionValue === activeValue;
                } else if (activeType === 'keywords') {
                    sectionValue = section.dataset.keywords ? section.dataset.keywords.toLowerCase().trim() : '';
                    const keywordsArray = sectionValue.split(',')
                        .map(kw => kw.trim())
                        .filter(kw => kw.length > 0);
                    if (activeValue && activeValue.includes(' ')) {
                        matches = keywordsArray.some(kw => kw === activeValue);
                    } else if (activeValue) {
                        matches = keywordsArray.some(kw => kw.includes(activeValue));
                    } else {
                        matches = false;
                    }
                }
                console.log(`Checking ${activeType}='${activeValue}' against section value='${sectionValue}': ${matches}`);
            }

            section.classList.toggle('hidden', !matches);
        });
    }

    // Initialize filters and fetch stats
    Object.keys(currentFilters).forEach(filter => filterSections(filter, 'all'));
    updateMemeStats();
});

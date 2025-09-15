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

    sections.forEach((section, idx) => {
        console.log(`Processing section ${idx + 1} data:`, section.dataset);
        if (section.dataset.type) {
            // Guard against undefined in split
            const typeStr = section.dataset.type.toString().toLowerCase().trim();
            typeStr.split(' ').forEach(t => {
                const trimmedT = t.trim();
                if (trimmedT) types.add(trimmedT);
            });
        }
        if (section.dataset.keywords) {
            // Parse keywords safely: Split on commas for easy typing
            const keywordsStr = section.dataset.keywords.toString().toLowerCase().trim();
            const keywordsArray = keywordsStr.split(',')
                .map(kw => kw.trim())
                .filter(kw => kw.length > 0);
            keywordsArray.forEach(kw => keywordsSet.add(kw));
        }
        if (section.dataset.meme) {
            // Parse meme safely
            const memeStr = section.dataset.meme.toString().toLowerCase().trim();
            if (memeStr) memes.add(memeStr);
        }

        const buttonsContainer = section.querySelector('.section-buttons');
        if (buttonsContainer) {
            const buttonData = [];
            // Add type buttons
            if (section.dataset.type) {
                const typeStr = section.dataset.type.trim();
                typeStr.split(' ').forEach(t => {
                    const tTrimmed = t.trim();
                    if (tTrimmed) {
                        const typeLower = tTrimmed.toLowerCase();
                        const typeUpper = tTrimmed.toUpperCase();
                        buttonData.push({ type: 'type', value: typeLower, label: `Type: ${typeUpper}` });
                    }
                });
            }
            // Add meme button
            if (section.dataset.meme) {
                const memeStr = section.dataset.meme.trim();
                const memeLower = memeStr.toLowerCase().trim();
                if (memeLower) {
                    buttonData.push({ type: 'meme', value: memeLower, label: `Meme: ${memeStr}` });
                }
            }
            // Add keywords buttons (no "Keyword:" prefix)
            if (section.dataset.keywords) {
                const keywordsStr = section.dataset.keywords.trim();
                const keywordsArray = keywordsStr.split(',')
                    .map(kw => kw.trim())
                    .filter(kw => kw.length > 0);
                keywordsArray.forEach(kw => {
                    const kwLower = kw.toLowerCase().trim();
                    if (kwLower) {
                        buttonData.push({ type: 'keywords', value: kwLower, label: `${kw}` });
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

    const sortedTypes = [...types].sort();
    const sortedKeywords = [...keywordsSet].sort();
    const sortedMemes = [...memes].sort();

    function createButtons(container, values, filterType) {
        if (container) {
            const allButton = document.createElement('button');
            allButton.textContent = 'All';
            allButton.dataset.filterType = filterType;
            allButton.dataset.value = 'all';
            allButton.addEventListener('click', () => filterSections(filterType, 'all'));
            container.appendChild(allButton);

            values.forEach(value => {
                // Guard against undefined value
                if (value && typeof value === 'string') {
                    const button = document.createElement('button');
                    let displayText;
                    if (filterType === 'type') {
                        if (value === 'non-mbti') {
                            displayText = 'non-mbti';
                        } else {
                            displayText = value.toUpperCase();
                        }
                    } else {
                        displayText = value.charAt(0).toUpperCase() + value.slice(1);
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

        // Update button active states for this filter type
        document.querySelectorAll(`button[data-filter-type="${filterType}"]`).forEach(btn => {
            const btnValue = btn.dataset.value; // Safe access
            const isActive = btnValue === currentFilters[filterType] && currentFilters[filterType] !== 'all';
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive);
        });

        sections.forEach(section => {
            section.classList.remove('hidden'); // Start with all visible
            const activeFilter = Object.entries(currentFilters).find(([key, val]) => val !== 'all');
            let matches = !activeFilter; // Default to true if no active filter

            if (activeFilter) {
                const [activeType, activeValue] = activeFilter;
                let sectionValue;

                if (activeType === 'type') {
                    sectionValue = section.dataset.type ? section.dataset.type.toLowerCase().trim() : '';
                    if (activeValue === 'non-mbti') {
                        matches = !sectionValue.split(' ').some(t => mbtiTypes.has(t));
                    } else {
                        matches = sectionValue.split(' ').includes(activeValue);
                    }
                } else if (activeType === 'meme') {
                    sectionValue = section.dataset.meme ? section.dataset.meme.toLowerCase().trim() : '';
                    matches = sectionValue === activeValue;
                } else if (activeType === 'keywords') {
                    sectionValue = section.dataset.keywords ? section.dataset.keywords.toLowerCase().trim() : '';
                    // Parse keywords for matching: Split on commas
                    const keywordsArray = sectionValue.split(',')
                        .map(kw => kw.trim())
                        .filter(kw => kw.length > 0);
                    // For singular/multi: if activeValue has spaces, exact match; else partial
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

    // Initialize all filters to 'all'
    Object.keys(currentFilters).forEach(filter => filterSections(filter, 'all'));
});

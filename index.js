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
            // Handle comma-separated types with spaces
            const typeStr = section.dataset.type.toString().toUpperCase().trim();
            typeStr.split(/[\s,]+/).forEach(t => {
                const trimmedT = t.trim();
                if (trimmedT) types.add(trimmedT);
            });
        }
        if (section.dataset.keywords) {
            // Parse keywords safely: Split on commas, force lowercase
            const keywordsStr = section.dataset.keywords.toString().toLowerCase().trim();
            const keywordsArray = keywordsStr.split(',')
                .map(kw => kw.trim())
                .filter(kw => kw.length > 0);
            keywordsArray.forEach(kw => keywordsSet.add(kw));
        }
        if (section.dataset.meme) {
            // Parse meme safely, force lowercase
            const memeStr = section.dataset.meme.toString().toLowerCase().trim();
            if (memeStr) memes.add(memeStr);
        }

        const buttonsContainer = section.querySelector('.section-buttons');
        if (buttonsContainer) {
            const buttonData = [];
            // Add type buttons
            if (section.dataset.type) {
                const typeStr = section.dataset.type.trim();
                typeStr.split(/[\s,]+/).forEach(t => {
                    const tTrimmed = t.trim();
                    if (tTrimmed) {
                        const typeUpper = tTrimmed.toUpperCase();
                        buttonData.push({ type: 'type', value: typeUpper, label: `Type: ${typeUpper}` });
                    }
                });
            }
            // Add meme button
            if (section.dataset.meme) {
                const memeStr = section.dataset.meme.toLowerCase().trim();
                if (memeStr) {
                    buttonData.push({ type: 'meme', value: memeStr, label: memeStr });
                }
            }
            // Add keywords buttons
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

    const mbtiTypes = new Set(['ESTP', 'ISTP', 'ESFP', 'ISFP', 'ESTJ', 'ISTJ', 'ESFJ', 'ISFJ', 'ENFP', 'INFP', 'ENFJ', 'INFJ', 'ENTJ', 'INTJ', 'ENTP', 'INTP']);
    mbtiTypes.forEach(t => types.add(t));
    types.add('non-mbti');
    types.add('All');

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
                if (value && typeof value === 'string') {
                    const button = document.createElement('button');
                    let displayText;
                    if (filterType === 'type') {
                        displayText = value === 'non-mbti' || value === 'All' ? value : value.toUpperCase();
                    } else {
                        displayText = value; // Already lowercase for meme and keywords
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
                    sectionValue = section.dataset.type ? section.dataset.type.toUpperCase().trim() : '';
                    if (activeValue === 'non-mbti') {
                        matches = !sectionValue.split(/[\s,]+/).some(t => mbtiTypes.has(t));
                    } else if (activeValue === 'All') {
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

    // Initialize all filters to 'all'
    Object.keys(currentFilters).forEach(filter => filterSections(filter, 'all'));
});

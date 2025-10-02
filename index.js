document.addEventListener('DOMContentLoaded', () => {
    const sections = document.querySelectorAll('.content-section');

    const containers = {
        type: document.getElementById('type-buttons'),
        meme: document.getElementById('meme-buttons'),
        keywords: document.getElementById('keywords-buttons')
    };

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

    // Update sections with stats buttons (optimized with parallel fetches)
    async function updateMemeStats() {
        const fetchTasks = [];

        sections.forEach(section => {
            const linkEl = section.querySelector('.image-links a[href]');
            if (linkEl && linkEl.href) {
                const urlMatch = linkEl.href.match(/imgflip\.com\/i\/([a-zA-Z0-9]+)/);
                if (urlMatch) {
                    const memeId = urlMatch[1];
                    section.dataset.memeId = memeId;

                    const buttonsContainer = section.querySelector('.section-buttons');
                    const loader = document.createElement('div');
                    loader.classList.add('loader');
                    buttonsContainer.appendChild(loader);

                    fetchTasks.push(
                        fetchMemeStats(memeId).then(stats => ({ section, stats, buttonsContainer, loader }))
                    );
                }
            }
        });

        const results = await Promise.all(fetchTasks);
        results.forEach(({ stats, buttonsContainer, loader }) => {
            buttonsContainer.removeChild(loader);

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
    }

    sections.forEach(section => {
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

        // Add accordion functionality
        const infoBox = section.querySelector('.info-box');
        const panel = section.querySelector('.image-container');
        const titleRow = section.querySelector('.title-row');
        const arrow = document.createElement('span');
        arrow.classList.add('arrow');
        arrow.textContent = '+';
        titleRow.insertBefore(arrow, titleRow.querySelector('.image-links'));

        infoBox.addEventListener('click', () => {
            infoBox.classList.toggle('active');
            const isActive = infoBox.classList.contains('active');
            arrow.textContent = isActive ? '-' : '+';
            panel.style.display = isActive ? 'block' : 'none';
        });

        // Start collapsed
        panel.style.display = 'none';
    });

    const mbtiTypes = new Set(['estp', 'istp', 'esfp', 'isfp', 'estj', 'istj', 'esfj', 'isfj', 'enfp', 'infp', 'enfj', 'infj', 'entj', 'intj', 'entp', 'intp']);
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
        }
    }

    createButtons(containers.type, sortedTypes, 'type');
    createButtons(containers.meme, sortedMemes, 'meme');
    createButtons(containers.keywords, sortedKeywords, 'keywords');

    let currentFilters = { type: 'all', meme: 'all', keywords: 'all' };

    function filterSections(filterType, value) {
        currentFilters[filterType] = value === currentFilters[filterType] ? 'all' : value;

        document.querySelectorAll(`button[data-filter-type="${filterType}"]`).forEach(btn => {
            const isActive = btn.dataset.value === currentFilters[filterType] && currentFilters[filterType] !== 'all';
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive);
        });

        sections.forEach(section => {
            let matches = true;
            Object.entries(currentFilters).forEach(([key, val]) => {
                if (val === 'all') return;
                let sectionValue = section.dataset[key] ? section.dataset[key].toLowerCase().trim() : '';
                if (key === 'type') {
                    const typesArray = sectionValue.split(/[\s,]+/);
                    if (val === 'non-mbti') {
                        matches &= !typesArray.some(t => mbtiTypes.has(t));
                    } else {
                        matches &= typesArray.includes(val);
                    }
                } else if (key === 'meme') {
                    matches &= sectionValue === val;
                } else if (key === 'keywords') {
                    const keywordsArray = sectionValue.split(',').map(kw => kw.trim());
                    matches &= keywordsArray.some(kw => kw.includes(val));
                }
            });
            section.classList.toggle('hidden', !matches);
        });
    }

    // Initialize
    Object.keys(currentFilters).forEach(filter => filterSections(filter, 'all'));
    updateMemeStats();
});

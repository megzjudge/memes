
document.addEventListener('DOMContentLoaded', () => {
    console.log('Script loaded at', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }));

    const sections = document.querySelectorAll('.content-section');
    console.log('Found sections:', sections.length, 'Details:', Array.from(sections).map(s => ({
        outerHTML: s.outerHTML.slice(0, 100),
        dataset: s.dataset
    })));

    const containers = {
        type: document.getElementById('type-buttons')
    };
    console.log('Container status:', Object.fromEntries(Object.entries(containers).map(([k, v]) => [k, v ? 'Present' : 'Missing'])));

    const dateLocale = 'en-AU';

    const types = new Set();

    function getGroup(value) {
        const num = parseInt(value);
        console.log(`getGroup('${value}') = ${num}`);
        if (isNaN(num)) return 'none';
        if (num < 50) return '<50';
        if (num < 100) return '>50';
        if (num < 200) return '>100';
        return '>200';
    }

    let hasTypes = false;

    sections.forEach((section, idx) => {
        console.log(`Processing section ${idx + 1} data:`, section.dataset);
        if (section.dataset.type) section.dataset.type.split(' ').forEach(t => types.add(t));
    });

    const sortedTypes = [...types].sort();

    function createButtons(container, values, filterType) {
        if (container) {
            const allButton = document.createElement('button');
            allButton.textContent = 'All';
            allButton.dataset.filterType = filterType;
            allButton.dataset.value = 'all';
            allButton.addEventListener('click', () => filterSections(filterType, 'all'));
            container.appendChild(allButton);

            values.forEach(value => {
                const button = document.createElement('button');
                button.textContent = value;
                button.dataset.filterType = filterType;
                button.dataset.value = value;
                button.addEventListener('click', () => filterSections(filterType, value));
                container.appendChild(button);
            });
        }
    }

    createButtons(containers.type, sortedTypes, 'type');

    let currentFilters = {
        type: 'all'
    };

    function filterSections(filterType, value) {

function filterSections() {
  const searchTerm = document.getElementById('search-bar').value.toLowerCase().trim();
  const hasSpacesFilter = document.getElementById('has-spaces').checked;
  const sections = document.querySelectorAll('.content-section');

  sections.forEach(section => {
    const type = section.dataset.type.toLowerCase().trim();
    const keywordsStr = section.dataset.keywords.toLowerCase().trim();

    // Parse keywords: Split by " to get phrases like ['dw sign won't...', 'memes', 'mbti', ...]
    const keywords = keywordsStr ? keywordsStr.split('"').map(kw => kw.trim()).filter(kw => kw.length > 0) : [];

    // Check if section has any multi-word keyword
    const hasMultiWord = keywords.some(kw => kw.includes(' '));

    // Search matching logic
    let matchesSearch = false;
    if (searchTerm === '') {
      matchesSearch = true; // Show all if empty
    } else if (searchTerm.includes(' ')) {
      // Multi-word search: Exact match against any keyword phrase
      matchesSearch = keywords.some(kw => kw === searchTerm);
    } else {
      // Singular search: Partial match against any keyword (handles "myers" in "myers briggs")
      matchesSearch = type.includes(searchTerm) || keywords.some(kw => kw.includes(searchTerm));
    }

    // Combine with has-spaces filter
    const matchesSpaces = !hasSpacesFilter || hasMultiWord;

    // Show/hide
    section.style.display = (matchesSearch && matchesSpaces) ? 'block' : 'none';
  });
}

// Event listeners (attach on load)
document.addEventListener('DOMContentLoaded', function() {
  const searchBar = document.getElementById('search-bar');
  const hasSpaces = document.getElementById('has-spaces');
  if (searchBar) searchBar.addEventListener('input', filterSections);
  if (hasSpaces) hasSpaces.addEventListener('change', filterSections);
  // Initial filter run
  filterSections();
});

// Optional: Dynamic buttons for MBTI (as before, but refined for multi-keywords)
const mbtiTypes = ['ESTP', 'ISTP', 'ESFP', 'ISFP', 'ESFJ', 'ISFJ', 'ESTJ', 'ISTJ', 'ENFJ', 'INFJ', 'ENFP', 'INFP', 'ENTJ', 'INTJ', 'ENTP', 'INTP', 'Not MBTI Related'];

function addTypeButtons() {
  const sections = document.querySelectorAll('.content-section');
  sections.forEach(section => {
    const buttonContainer = section.querySelector('.section-buttons');
    if (buttonContainer) {
      buttonContainer.innerHTML = ''; // Clear
      mbtiTypes.forEach(type => {
        const typeLower = type.toLowerCase();
        if (section.dataset.type.toLowerCase() === typeLower || 
            section.dataset.keywords.toLowerCase().includes(typeLower)) {
          const button = document.createElement('button');
          button.textContent = type;
          button.addEventListener('click', () => {
            document.getElementById('search-bar').value = type;
            filterSections();
          });
          buttonContainer.appendChild(button);
        }
      });
    }
  });
}

// Run buttons on load
document.addEventListener('DOMContentLoaded', addTypeButtons);

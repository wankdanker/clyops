const results = document.getElementById('results');
if (results) {
  const query = new URLSearchParams(location.search).get('q')?.trim() ?? '';
  document.getElementById('search').value = query;
  if (query) {
    fetch(document.body.dataset.searchIndex).then(response => {
      if (!response.ok) throw new Error('Search index unavailable');
      return response.json();
    }).then(entries => {
      const words = query.toLowerCase().split(/\s+/);
      const matches = entries.filter(entry => words.every(word => `${entry.title} ${entry.text}`.toLowerCase().includes(word)));
      results.textContent = matches.length ? `${matches.length} matching ${matches.length === 1 ? "guide" : "guides"}` : 'No matching guides.';
      const list = document.createElement('ul');
      for (const entry of matches) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = entry.url;
        link.textContent = entry.title;
        item.append(link);
        list.append(item);
      }
      results.append(list);
    }).catch(() => { results.textContent = 'Search is unavailable. Use the navigation or API references.'; });
  }
}

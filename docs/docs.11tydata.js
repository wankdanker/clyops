module.exports = {
  layout: 'page.njk',
  permalink: ({ page }) => `${page.filePathStem}.html`,
};

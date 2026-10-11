import fs from 'node:fs';
import path from 'node:path';

export default function (config) {
  // Generated reference Markdown is ignored by Git, but is a site input.
  config.setUseGitIgnore(false);
  config.addPassthroughCopy({ 'docs/assets': 'assets', 'docs/_native': 'reference' });
  config.addPassthroughCopy({ 'docs/_generated/home-demo.json': 'assets/home-demo.json', 'docs/examples/home': 'demos' });
  config.addPassthroughCopy({ 'docs/_generated/playground-files.json': 'assets/playground-files.json' });
  config.addPassthroughCopy({ 'docs/_generated/linux-lab': 'assets/linux-lab' });
  config.addPassthroughCopy({ 'docs/_generated/linux-runtime': 'linux-runtime' });
  config.addFilter('labRuntimeUrl', url => {
    const root = (process.env.DOCS_PATH_PREFIX ?? '/').replace(/\/versions\/[^/]+\/$/, '/');
    return root.replace(/\/$/, '') + url;
  });
  config.ignores.add('docs/_native/**');
  config.ignores.add('docs/examples/**');
  config.ignores.add('docs/README.md');
  config.ignores.add('docs/release-footer.md');
  config.on('eleventy.after', ({ dir }) => {
    const entries = [];
    function visit(folder) {
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, item.name);
        if (item.isDirectory() && !['_native', '_includes', '_data', 'examples'].includes(item.name)) visit(file);
        else if (item.isFile() && file.endsWith('.md')) {
          const source = fs.readFileSync(file, 'utf8');
          const title = source.match(/^title: (.+)$/m)?.[1];
          const permalink = source.match(/^permalink: (.+)$/m)?.[1];
          if (title) entries.push({ title, url: prefix(permalink ?? '/' + file.slice(5).replace(/\.md$/, '.html')), text: source.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/[`#*]/g, '').slice(0, 20000) });
        }
      }
    }
    visit('docs');
    fs.writeFileSync(path.join(dir.output, 'search-index.json'), JSON.stringify(entries));
  });
  config.addFilter('version', () => JSON.parse(fs.readFileSync('packages/js/package.json')).version);
  // Keep Markdown useful on GitHub as well as on the site. Local .md links
  // become HTML links, and repository source/spec links lead to GitHub.
  config.amendLibrary('md', md => {
    md.renderer.rules.heading_open = (tokens, i, opts, env, self) => {
      const label = tokens[i + 1].content.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
      const counts = env.headingCounts ??= new Map();
      const count = counts.get(label) ?? 0;
      counts.set(label, count + 1);
      tokens[i].attrSet('id', count ? `${label}-${count}` : label);
      return self.renderToken(tokens, i, opts);
    };
    const render = md.renderer.rules.link_open ?? ((tokens, i, opts, env, self) => self.renderToken(tokens, i, opts));
    md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
      const token = tokens[i];
      const href = token.attrGet('href');
      if (href && !/^(?:[a-z]+:|#|\/)/i.test(href)) {
        const input = env.page?.inputPath;
        if (input) {
          const [file, fragment] = href.split('#');
          const target = path.normalize(path.join(path.dirname(input), file));
          if (target.startsWith('docs/') && file.endsWith('.md')) {
            const url = '/' + target.slice(5).replace(/\.md$/, '.html').replace(/^index\.html$/, '');
            token.attrSet('href', prefix(url) + (fragment ? '#' + fragment : ''));
          } else if (!target.startsWith('docs/')) {
            const kind = fs.existsSync(target) && fs.statSync(target).isDirectory() ? 'tree' : 'blob';
            const revision = process.env.DOCS_SOURCE_REF ?? process.env.GITHUB_SHA ?? 'main';
            token.attrSet('href', `https://github.com/wankdanker/clyops/${kind}/${revision}/${target}` + (fragment ? '#' + fragment : ''));
          }
        }
      } else if (href?.startsWith('/') && !href.startsWith('//')) token.attrSet('href', prefix(href));
      return render(tokens, i, opts, env, self);
    };
  });
  return {
    dir: { input: 'docs', output: '_site', includes: '_includes', data: '_data' },
    templateFormats: ['md', 'njk'],
    markdownTemplateEngine: false,
    htmlTemplateEngine: false,
    pathPrefix: process.env.DOCS_PATH_PREFIX ?? '/',
  };
}

function prefix(url) {
  return (process.env.DOCS_PATH_PREFIX ?? '/').replace(/\/$/, '') + url;
}

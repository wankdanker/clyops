# Icons

From `apps/runner`, generate the icons from `icon.svg` with:

```sh
pnpm exec tauri icon src-tauri/icons/icon.svg -o src-tauri/icons
```

Then delete the `android/`, `ios/` and Windows Store (`Square*`, `StoreLogo`) outputs, which we do not ship.

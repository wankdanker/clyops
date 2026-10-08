# Icons

Place your application icons here:

- `32x32.png` - 32x32 pixel PNG
- `128x128.png` - 128x128 pixel PNG
- `128x128@2x.png` - 256x256 pixel PNG (retina)
- `icon.icns` - macOS icon file
- `icon.ico` - Windows icon file

For now, you can use placeholder icons or generate them from a base image using tools like:
- https://icon.kitchen/
- https://easyappicon.com/
- ImageMagick: `convert base.png -resize 32x32 32x32.png`

## Quick Icon Generation

If you have ImageMagick installed, you can generate icons from a base image:

```bash
# Create a base 512x512 PNG image first, then:
convert base.png -resize 32x32 32x32.png
convert base.png -resize 128x128 128x128.png
convert base.png -resize 256x256 128x128@2x.png
```

For now, the app will use default Tauri icons if these are not present.

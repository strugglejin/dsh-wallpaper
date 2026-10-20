"""Prepares wallpaper sources for the dsh-wallpaper plugin.

Browsers get the image as-is, so whatever the plugin inlines is what the user
sees. A 4K photo behind a dark UI is too loud: this downsamples, softens and
slightly darkens it so the panels stay readable, and writes a small JPEG that
keeps the bundle reasonable.

    python scripts/prepare_image.py "D:\\壁纸\\t0161b2777dfb6e9e82.jpg" assets/bg-street.jpg --blur 6 --scale 0.9
"""
import argparse
import pathlib

from PIL import Image, ImageEnhance, ImageFilter


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("dest")
    ap.add_argument("--width", type=int, default=2560)
    ap.add_argument("--blur", type=float, default=0.0, help="gaussian radius in output pixels")
    ap.add_argument("--scale", type=float, default=1.0, help="brightness multiplier")
    ap.add_argument("--quality", type=int, default=85)
    args = ap.parse_args()

    src = pathlib.Path(args.source)
    dest = pathlib.Path(args.dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(src) as im:
        im = im.convert("RGB")
        before = im.size
        if im.width > args.width:
            height = round(im.height * args.width / im.width)
            im = im.resize((args.width, height), Image.LANCZOS)
        if args.blur > 0:
            im = im.filter(ImageFilter.GaussianBlur(args.blur))
        if args.scale != 1.0:
            im = ImageEnhance.Brightness(im).enhance(args.scale)
        im.save(dest, "JPEG", quality=args.quality, optimize=True, progressive=True)

    size = dest.stat().st_size
    print(f"{src.name}: {before[0]}x{before[1]} -> {im.width}x{im.height}, {size / 1024:.0f} KiB -> {dest}")
    if size > 4 * 1024 * 1024:
        print("warning: still large; lower --quality or --width")


if __name__ == "__main__":
    main()

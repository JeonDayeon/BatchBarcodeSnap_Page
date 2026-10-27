# BatchBarcode Web Scanner

Standalone static web scanner for Data Matrix, Code 128, QR Code, and other supported barcode formats.

## GitHub Pages

Upload this folder to a new repository's `main` branch. In **Settings → Pages**, choose **GitHub Actions** as the deployment source. The included workflow deploys after each push.

## Notes

- Camera access requires HTTPS and browser permission. GitHub Pages provides HTTPS.
- ZXing-JS loads from `esm.sh`, so scanning needs an internet connection.
- Results and selected photos stay in this browser's IndexedDB on this device. They are not uploaded or synchronized.
- Use Copy, CSV, or Share to take results out. Finish/Deliver only sends results when embedded in a same-origin parent page.

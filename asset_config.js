export const ASSET_BASE_URL = "https://qanat-label-assets.pages.dev/releases/jpeg85-maskgzip-20261021-0cec3aa7606d/";
// Assets read from this site's own locations/<map>/ folder, not from the release above. The release is frozen and
// shared with production, so prediction views added later live beside the page. LOCAL_ASSETS maps a requested name
// to the local file that answers it; names matching LOCAL_ASSET_PATTERN are local under their own name.
// Empty map and null pattern = everything comes from the release.
export const LOCAL_ASSETS = Object.freeze({"manifest.enc": "manifest.v3models-20261119.enc"});
export const LOCAL_ASSET_PATTERN = /^heatmap-v3models-20261119-[\w-]+\.enc$/;

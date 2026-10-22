// PIL-compatible cutoff=1 histogram and truncating LUT; mask refers to ORIGINAL pixels.
export const CONTRAST_VERSION='exclude-nodata-pil-cutoff1-v1';
export function unpackValidMask(bytes,n=1024*1024) {
  if(bytes.length!==Math.ceil(n/8)) throw new Error('Invalid nodata mask length');
  return Uint8Array.from({length:n},(_,i)=>(bytes[i>>3]>>(7-(i&7)))&1);
}
// Inline masks live inside the encrypted manifest and preserve pre-JPEG validity.
export async function decodeInlineValidMask(spec,n=1024*1024) {
  if(!spec || typeof spec!=='object')throw new Error('Invalid inline nodata mask');
  if(spec.encoding==='all-valid')return new Uint8Array(n).fill(1);
  if(spec.encoding!=='gzip-bitpack-msb-v1' || typeof spec.data!=='string')throw new Error('Unsupported inline nodata mask encoding');
  const compressed=Uint8Array.from(atob(spec.data),c=>c.charCodeAt(0));
  const stream=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const bytes=new Uint8Array(await new Response(stream).arrayBuffer());
  return unpackValidMask(bytes,n);
}
export function maskedContrast(data,mask) {
  const n=data.length/4;if(mask.length!==n)throw new Error('Mask/image dimensions differ');
  const hist=new Uint32Array(256);let count=0;
  for(let i=0;i<n;i++)if(mask[i]){hist[data[4*i]]++;count++;}
  const cut=Math.floor(count*.01),trim=hist.slice();let remaining=cut;
  for(let v=0;v<256;v++){const k=Math.min(remaining,trim[v]);trim[v]-=k;remaining-=k;if(!remaining)break;}
  remaining=cut;for(let v=255;v>=0;v--){const k=Math.min(remaining,trim[v]);trim[v]-=k;remaining-=k;if(!remaining)break;}
  let lo=0,hi=255;while(lo<256&&!trim[lo])lo++;while(hi>=0&&!trim[hi])hi--;
  const lut=Uint8Array.from({length:256},(_,v)=>hi<=lo?v:Math.max(0,Math.min(255,Math.floor(v*(255/(hi-lo))-lo*(255/(hi-lo))))));
  const out=new Uint8ClampedArray(data.length);
  for(let i=0;i<n;i++){for(let c=0;c<3;c++)out[i*4+c]=mask[i]?lut[data[i*4+c]]:0;out[i*4+3]=255;}
  return out;
}

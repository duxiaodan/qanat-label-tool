import {ASSET_BASE_URL} from './asset_config.js';
export const LOCATIONS = Object.freeze({
  erbil: {name:'Erbil',crs:'EPSG:32638',originals:true},
  aleppo: {name:'Aleppo',crs:'EPSG:32637',originals:false},
  dezful: {name:'Dezful',crs:'EPSG:32639',originals:false},
});
export function locationId(search) {
  const value=new URLSearchParams(search).get('location') || 'erbil';
  if(!Object.hasOwn(LOCATIONS,value)) throw new Error('Unknown location');
  return value;
}
export function locationAsset(id,name) {
  if(!Object.hasOwn(LOCATIONS,id) || typeof name!=='string' || name.startsWith('/') || name.includes('..') || /[:\\]/.test(name)) throw new Error('Invalid location asset');
  const relative = `locations/${id}/${name}`;
  return ASSET_BASE_URL ? new URL(relative, ASSET_BASE_URL).href : relative;
}
export function boardFor(manifest) {
  return manifest.board || (manifest.swath.world_bounds.map(v=>Math.round(v)).join('_'));
}

import type {ReactNode} from 'react';

export type IconName='refresh'|'plus'|'search'|'terminal'|'folder'|'chevron'|'settings'|'info'|'close'|'check'|'grid'|'book'|'expand'|'copy'|'computer'|'more';

const icons:Record<IconName,ReactNode>={
 refresh:<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>,
 plus:<path d="M12 5v14M5 12h14"/>,
 search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
 terminal:<path d="m5 7 5 5-5 5m8 0h6"/>,
 folder:<path d="M3 8V5h7l2 3h9v12H3z"/>,
 chevron:<path d="m9 5 7 7-7 7"/>,
 settings:<><path d="M4 7h16M4 17h16"/><rect x="8" y="4" width="4" height="6" rx="1"/><rect x="14" y="14" width="4" height="6" rx="1"/></>,
 info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v2"/></>,
 close:<path d="m6 6 12 12M6 18 18 6"/>,
 check:<path d="m5 12 4 4L19 6"/>,
 grid:<><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
 book:<path d="M12 5v15m0-15C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1z"/>,
 expand:<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>,
 copy:<><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>,
 computer:<><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
 more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
};

export function Icon({name,className=''}:{name:IconName;className?:string}){
 return <svg className={`icon ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true">{icons[name]}</svg>;
}

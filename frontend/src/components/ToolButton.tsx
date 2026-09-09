import {Icon,type IconName} from './Icon';

interface Props{
 label:string;
 icon:IconName;
 onClick:()=>void;
 disabled?:boolean;
 pressed?:boolean;
 className?:string;
}

export function ToolButton({label,icon,onClick,disabled,pressed,className=''}:Props){
 return <button type="button" className={`icon-button glass-control ${className}`.trim()} title={label} aria-label={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}><Icon name={icon}/></button>;
}

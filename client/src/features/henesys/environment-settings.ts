export const TIMES = [['清晨',6.4],['上午',9.5],['正午',12],['傍晚',17],['黄昏',18.6],['星夜',22]] as const;
export const WEATHERS = [['clear','晴朗'],['clouds','多云'],['mist','云雾'],['drizzle','小雨'],['rain','大雨'],['snow','飘雪'],['aurora','极光']] as const;
export const SEASONS = [['spring','春'],['summer','夏'],['autumn','秋'],['winter','冬']] as const;
export type EnvironmentSettings={hour:number;weather:typeof WEATHERS[number][0];season:typeof SEASONS[number][0];moisture:number;grade:number};
export const DEFAULT_ENVIRONMENT:EnvironmentSettings={hour:9.5,weather:'clear',season:'spring',moisture:.15,grade:0};
export function environmentSettings(value:Partial<EnvironmentSettings>={}):EnvironmentSettings{
 const finite=(v:unknown,fallback:number,min:number,max:number)=>typeof v==='number'&&Number.isFinite(v)?Math.min(max,Math.max(min,v)):fallback;
 return {hour:finite(value.hour,DEFAULT_ENVIRONMENT.hour,0,24),weather:WEATHERS.some(w=>w[0]===value.weather)?value.weather!:DEFAULT_ENVIRONMENT.weather,season:SEASONS.some(s=>s[0]===value.season)?value.season!:DEFAULT_ENVIRONMENT.season,moisture:finite(value.moisture,DEFAULT_ENVIRONMENT.moisture,0,1),grade:finite(value.grade,0,0,.2)};
}
export function loadEnvironment():EnvironmentSettings{try{return environmentSettings(JSON.parse(localStorage.getItem('chuxian-environment')??'{}'));}catch{return {...DEFAULT_ENVIRONMENT};}}
export function saveEnvironment(value:EnvironmentSettings){try{localStorage.setItem('chuxian-environment',JSON.stringify(value));}catch{}}
export function environmentLight(settings:EnvironmentSettings){
 const declination={spring:8,summer:23,autumn:-6,winter:-23}[settings.season]*Math.PI/180,latitude=34*Math.PI/180,angle=(settings.hour-12)*Math.PI/12;
 const direction=[-Math.sin(angle)*Math.cos(declination),Math.sin(latitude)*Math.sin(declination)+Math.cos(latitude)*Math.cos(declination)*Math.cos(angle),Math.cos(latitude)*Math.sin(declination)-Math.sin(latitude)*Math.cos(declination)*Math.cos(angle)] as [number,number,number];
 const smooth=(a:number,b:number,x:number)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
 const daylight=smooth(-.10,.12,direction[1]),sunlight=smooth(0,.16,direction[1]);
 const rain=settings.weather==='rain'?1:settings.weather==='drizzle'?.32:0,snow=settings.weather==='snow'?1:0;
 const cover=settings.weather==='clear'||settings.weather==='aurora'?.22:settings.weather==='clouds'?.68:settings.weather==='mist'?.76:.94;
 return {direction,daylight,sunlight,rain,snow,cover,wet:Math.max(settings.moisture,rain*.9),fog:settings.weather==='mist'?.014:rain?.004:settings.weather==='snow'?.003:.00065};
}

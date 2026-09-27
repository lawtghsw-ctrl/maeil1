export type AppRole="ADMIN"|"STAFF";

export const ADMIN_ONLY_PATHS=["/settlements","/changes","/analytics"] as const;

export function normalizeRole(value:unknown):AppRole{
 return String(value||"").toUpperCase()==="ADMIN"?"ADMIN":"STAFF";
}

export function isAdminOnlyPath(pathname:string){
 return ADMIN_ONLY_PATHS.some(path=>pathname===path||pathname.startsWith(`${path}/`));
}

export function roleLabel(role:AppRole){
 return role==="ADMIN"?"최종관리자":"직원";
}

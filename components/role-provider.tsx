"use client";
import React,{createContext,useContext} from "react";
import {AppRole,normalizeRole,roleLabel} from "@/lib/rbac";

type RoleContextValue={
 name:string;
 role:AppRole;
 isAdmin:boolean;
 roleLabel:string;
};

const RoleContext=createContext<RoleContextValue|undefined>(undefined);

export function RoleProvider({children,initialProfile}:{children:React.ReactNode;initialProfile:{name:string;role:string}}){
 const role=normalizeRole(initialProfile.role);
 const value:RoleContextValue={name:initialProfile.name||"사용자",role,isAdmin:role==="ADMIN",roleLabel:roleLabel(role)};
 return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(){
 const value=useContext(RoleContext);
 if(!value)throw new Error("RoleProvider missing");
 return value;
}

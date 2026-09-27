import {type NextRequest} from "next/server";
import {updateSession} from "@/lib/supabase/proxy";

export async function proxy(request:NextRequest){
  return await updateSession(request);
}

// External lead ingest endpoints must bypass the Admin auth proxy entirely.
export const config={
  matcher:[
    "/((?!api/meta/webhook(?:/|$)|api/google-sheet/lead(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

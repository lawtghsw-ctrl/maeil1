import {NextResponse,type NextRequest} from "next/server";
import {updateSession} from "@/lib/supabase/proxy";

export async function proxy(request:NextRequest){
  const response=await updateSession(request);
  return response;
}

export const config={
  matcher:[
    "/((?!api/meta/webhook(?:/|$)|api/google-sheet/lead(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

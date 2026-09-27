import type {Metadata,Viewport} from "next";
import "./globals.css";
import {BRAND_NAME} from "@/lib/brand";
export const metadata:Metadata={title:`${BRAND_NAME} Admin`,description:"불법사채 구제센터 통합 업무관리"};
export const viewport:Viewport={width:"device-width",initialScale:1,viewportFit:"cover"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ko"><body>{children}</body></html>}

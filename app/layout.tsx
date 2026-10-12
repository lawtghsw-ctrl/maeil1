import type {Metadata,Viewport} from "next";
import "./globals.css";
export const metadata:Metadata={title:"로파워 사채 ADMIN",description:"불법사채 구제센터 통합 업무관리"};
export const viewport:Viewport={width:"device-width",initialScale:1,viewportFit:"cover"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ko"><body>{children}</body></html>}

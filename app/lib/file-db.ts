import {createClient} from "@/lib/supabase/client";
const BUCKET="board-files";
function safeName(name:string){return name.replace(/[^a-zA-Z0-9._-]/g,"_")}
export async function saveFile(id:string,file:File){const supabase=createClient();const path=`${new Date().toISOString().slice(0,10)}/${id}-${safeName(file.name)}`;const {error}=await supabase.storage.from(BUCKET).upload(path,file,{upsert:false,contentType:file.type||undefined});if(error)throw error;return path}
export async function getFile(path:string):Promise<Blob|undefined>{const supabase=createClient();const {data,error}=await supabase.storage.from(BUCKET).download(path);if(error){console.error(error);return undefined}return data}
export async function deleteFile(path:string){if(!path)return;const supabase=createClient();const {error}=await supabase.storage.from(BUCKET).remove([path]);if(error)throw error}

export const BRAND_NAME=(process.env.NEXT_PUBLIC_BRAND_NAME||"로파워").trim()||"로파워";
export const NOTICE_SENDER_NAME=(process.env.NEXT_PUBLIC_NOTICE_SENDER_NAME||BRAND_NAME).trim()||BRAND_NAME;
export const BANK_NOTICE=(process.env.NEXT_PUBLIC_BANK_NOTICE||"").trim();

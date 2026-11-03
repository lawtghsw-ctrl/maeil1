type LeadApplicationFields={
 source?:string;
 legacyApplicationDetails?:boolean;
 collectionIntensity:string;
 principalAmount:string;
 repaymentTotal:string;
 evidence:string;
 thirdPartyDamage:string;
};

export function showsLegacyApplicationDetails(lead:LeadApplicationFields){
 // Eligibility is frozen at cutover, even if duplicate intake later enriches the source IDs.
 return lead.legacyApplicationDetails===true;
}

export function LeadApplicationInfo({lead}:{lead:LeadApplicationFields}){
 const fields=[
  ["추심강도",lead.collectionIntensity],
  ["대여원금",lead.principalAmount],
  ["상환총액",lead.repaymentTotal],
  ...(showsLegacyApplicationDetails(lead)?[["증거보유",lead.evidence],["주변인피해",lead.thirdPartyDamage]]:[]),
 ];
 return <dl className="ropower-lead-application rounded-xl bg-slate-50 p-3 text-xs">
  {fields.map(([label,value])=><div className="ropower-lead-application-row" key={label}>
   <dt className="text-slate-500">{label}</dt>
   <dd className="font-semibold text-slate-800" title={value||undefined}>{value||"-"}</dd>
  </div>)}
 </dl>;
}

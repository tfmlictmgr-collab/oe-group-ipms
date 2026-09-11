// Adds a small, realistic asset sample to the dev DB so the register screens
// have content to verify against. Idempotent: skips tags that already exist.
import path from "node:path"; import { fileURLToPath } from "node:url";
import { config } from "dotenv"; import { createClient } from "@supabase/supabase-js";
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
const fm = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
await fm.auth.signInWithPassword({ email:"oe-group-foundation-poc.facilitymanager@oegroup.test", password:"OEGroupDemo2026!" });
const { data:{user} } = await fm.auth.getUser();
const { data: me } = await fm.from("users").select("org_id").eq("id", user.id).single();
const { data: staked } = await svc.from("property_stakeholders").select("property_id").eq("user_id", user.id);
const { data: props } = await svc.from("properties").select("id, name").in("id", staked.map(s=>s.property_id));
const P = Object.fromEntries(props.map(p=>[p.name, p.id]));
const names = Object.keys(P);
const a = names[0], b = names[1] ?? names[0];
const today = new Date();
const plus = (d) => new Date(today.getTime()+d*86400000).toISOString().slice(0,10);

const rows = [
  { asset_tag:"GEN-IKJ-001", name:"Perkins 250kVA Generator", category:"power_generation", criticality:"critical",
    manufacturer:"Perkins", model:"2506A-E15", serial_number:"8841207", location_detail:"Roof plant room, Level 3",
    property_id:P[a], condition:"good", purchase_cost:18500000, replacement_cost:24000000,
    purchase_date:"2023-04-12", commissioned_date:"2023-05-02", expected_life_years:15,
    compliance_required:true, regulatory_standard:"SON", certifying_body:"Lagos State Fire Service",
    certificate_number:"LSFS/2026/4417", certificate_expiry:plus(18), next_service_due:plus(9),
    insurer_name:"Leadway Assurance", insurance_policy_no:"LW-PL-99231", insured_value:20000000, insurance_expiry:plus(160) },
  { asset_tag:"LFT-IKJ-002", name:"Passenger Lift — Core A", category:"lifts_escalators", criticality:"critical",
    manufacturer:"Kone", model:"MonoSpace 500", serial_number:"KN-44913", location_detail:"Core A shaft",
    property_id:P[a], condition:"good", compliance_required:true, regulatory_standard:"LOLER",
    certificate_expiry:plus(240), next_service_due:plus(55), replacement_cost:31000000 },
  { asset_tag:"HVA-LEK-014", name:"Chiller Unit — Block B", category:"hvac", criticality:"high",
    manufacturer:"Carrier", model:"30XA-802", serial_number:"CR-70225", location_detail:"Level 3 plant",
    property_id:P[b], condition:"fair", next_service_due:plus(4), purchase_cost:12400000 },
  { asset_tag:"FIR-LEK-031", name:"Fire Alarm Panel", category:"fire_safety", criticality:"critical",
    manufacturer:"Honeywell", model:"NOTIFIER NFS2", serial_number:"HW-1182", location_detail:"Ground lobby",
    property_id:P[b], condition:"good", compliance_required:true, regulatory_standard:"NFPA 72",
    certifying_body:"Lagos State Fire Service", certificate_expiry:plus(-12) },
  { asset_tag:"PMP-IKJ-007", name:"Booster Pump Set", category:"plumbing", criticality:"medium",
    manufacturer:"Grundfos", model:"Hydro MPC-E", serial_number:"GF-3390", location_detail:"Basement tank room",
    property_id:P[a], condition:"good", next_service_due:plus(110) },
  { asset_tag:"SEC-IKJ-021", name:"CCTV NVR — 32 channel", category:"security", criticality:"high",
    manufacturer:"Hikvision", model:"DS-9632NI", serial_number:"HK-55120", location_detail:"Security room",
    property_id:P[a], condition:"good", purchase_cost:2100000 },
];

let added = 0, skipped = 0;
for (const r of rows) {
  const { data: exists } = await svc.from("assets").select("id").eq("org_id", me.org_id).ilike("asset_tag", r.asset_tag).maybeSingle();
  if (exists) { skipped++; continue; }
  const { error } = await svc.from("assets").insert({ ...r, org_id: me.org_id, created_by: user.id });
  if (error) console.log("  ERR", r.asset_tag, error.message); else added++;
}
console.log(`assets seeded: ${added} added, ${skipped} already present (properties: ${names.join(", ")})`);

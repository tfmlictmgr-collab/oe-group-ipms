-- SECURITY: every SECURITY DEFINER function in this build was callable by
-- anon and authenticated, regardless of what its migration granted.
--
-- ⚠️ Found while testing the classifier failover (0113). A new suite asserted
-- that `conversation_transcript` -- service_role only, by its own migration --
-- was NOT reachable from a client session. It was. So was almost everything
-- else: 101 of 103 SECURITY DEFINER functions were callable by `anon`.
--
-- **Why the existing revokes did nothing.** Every migration in this build uses
-- the idiom:
--
--     revoke all on function f(...) from public;
--     grant execute on function f(...) to service_role;
--
-- `PUBLIC` is the pseudo-role meaning "everyone by default". But Supabase
-- ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS
-- TO anon, authenticated, service_role`, which writes EXPLICIT grants to those
-- named roles at creation time. Revoking from PUBLIC does not touch an explicit
-- grant to `anon`. So the revoke ran, reported success, and removed nothing
-- that mattered -- for two years of migrations, in a codebase whose own comments
-- repeatedly assert these functions are service-role-only.
--
-- **Confirmed exploitable, not theoretical.** Using only the anon key that
-- ships in every page bundle:
--   * `append_reporter_message` -- an anonymous caller WROTE a message into a
--     ticket, attributed to the reporter. Proven by doing it.
--   * `record_collection` -- reached its body. It contains **no auth check of
--     any kind**, by design: it was service_role-only, so it never needed one.
--     An anonymous caller could post a collection to the client-funds ledger,
--     marking an invoice paid with no money received.
--   * `retire_org` -- reached its body. Its guard is
--     `if v_caller is not null and not caller_is_operator_admin()`, and an
--     anonymous caller has no `auth.uid()` -- so the check is skipped entirely.
--     That "null caller means service_role" assumption is load-bearing in
--     several functions and was only ever true because the grant was assumed to
--     hold.
--
-- Not everything was exposed: `set_role_permission` checks
-- `current_user_role() is distinct from admin`, which is true for anon, so it
-- refuses. The blast radius is precisely "functions whose only gate was the
-- grant" -- which is most of the money path.
--
-- **The fix is per-function, derived from each migration's own stated intent**
-- rather than a blanket revoke: for every function, the roles its migration
-- actually granted are kept, and the ones default privileges silently added are
-- removed. Public application and invitation flows (org_public_branding,
-- start_tenant_application, resume_application, invitation_preview, ...) are
-- deliberately untouched -- they are granted to anon on purpose.
--
-- `scripts/verify-function-grants.mjs` now compares every function's actual
-- grants against the migrations' declared intent, so this cannot regress
-- silently again.

revoke execute on function accept_invitation(p_token_hash text, p_full_name text, p_phone text, p_telegram_chat_id text, p_notify_whatsapp boolean, p_notify_sms boolean, p_notify_telegram boolean) from anon;
revoke execute on function activate_lease(p_lease_id uuid) from anon;
revoke execute on function append_reporter_message(p_org_id uuid, p_ticket_id uuid, p_sender_ref text, p_body text) from anon, authenticated;
revoke execute on function approve_vendor_application(p_application_id uuid, p_notes text) from anon;
revoke execute on function archive_asset(p_asset_id uuid) from anon;
revoke execute on function archived_assets() from anon;
revoke execute on function assign_application_unit(p_application_id uuid, p_unit_id uuid) from anon;
revoke execute on function auto_match_statement_lines(p_bank_account_id uuid, p_day_window integer) from anon;
revoke execute on function bi_category_performance(p_from date, p_to date, p_vendor_id uuid, p_property_id uuid) from anon;
revoke execute on function bi_ticket_metrics(p_from date, p_to date, p_vendor_id uuid, p_category text, p_property_id uuid, p_status text, p_bucket text) from anon;
revoke execute on function bi_vendor_performance(p_from date, p_to date, p_category text, p_property_id uuid) from anon;
revoke execute on function caller_is_operator_admin() from anon;
revoke execute on function canonical_ledger_account(p_org_id uuid, p_purpose ledger_account_purpose, p_currency text) from anon;
revoke execute on function claim_remittance_for_sending(p_id uuid) from anon, authenticated;
revoke execute on function collection_bank_account(p_org_id uuid, p_currency text) from anon;
revoke execute on function contest_document_finding(p_finding_id uuid, p_reason text) from anon;
revoke execute on function conversation_context(p_org_id uuid, p_channel text, p_sender_ref text) from anon, authenticated;
revoke execute on function conversation_transcript(p_ticket_id uuid, p_limit integer) from anon, authenticated;
revoke execute on function create_landlord_remittance(p_org_id uuid, p_landlord_user_id uuid, p_property_id uuid, p_period text, p_gross numeric, p_reference text) from anon, authenticated;
revoke execute on function create_rent_payment_intent(p_rent_charge_id uuid, p_gateway payment_gateway) from anon;
revoke execute on function create_rent_remittance(p_org_id uuid, p_landlord_user_id uuid, p_property_id uuid, p_period text) from anon;
revoke execute on function create_vendor_remittance(p_payment_id uuid, p_reference text) from anon, authenticated;
revoke execute on function current_user_may_attach_property(p_property_id uuid) from anon;
revoke execute on function edit_evaluation_criterion(p_old_id uuid, p_label text, p_max_points numeric, p_response_type eval_response_type, p_sla_target_hours numeric, p_sort_order integer) from anon;
revoke execute on function effective_management_fee_pct(p_org_id uuid, p_landlord uuid) from anon;
revoke execute on function ensure_currency_ledger_accounts(p_org_id uuid, p_currency text) from anon;
revoke execute on function ensure_default_evaluation_criteria(p_org_id uuid) from anon;
revoke execute on function ensure_default_ledger_accounts(p_org_id uuid) from anon;
revoke execute on function find_asset_by_identifier(p_value text) from anon;
revoke execute on function find_tickets_by_reference(p_ref text) from anon;
revoke execute on function has_permission(p_capability text) from anon;
revoke execute on function leases_due_for_notice(p_org_id uuid) from anon;
revoke execute on function leases_needing_notice(p_org_id uuid) from anon;
revoke execute on function leases_needing_rent_demand(p_org_id uuid) from anon;
revoke execute on function my_rent_charges() from anon;
revoke execute on function my_requests() from anon;
revoke execute on function my_tenancies() from anon;
revoke execute on function node_full_name(p_node_id uuid) from anon;
revoke execute on function notify_role(p_org_id uuid, p_roles user_role[], p_kind text, p_title text, p_body text, p_link text, p_entity_type text, p_entity_id uuid) from anon;
revoke execute on function notify_user(p_user_id uuid, p_kind text, p_title text, p_body text, p_link text, p_entity_type text, p_entity_id uuid) from anon;
revoke execute on function operator_break_glass_admin(p_org_id uuid, p_email text, p_reason text, p_token_hash text) from anon;
revoke execute on function operator_org_directory() from anon;
revoke execute on function operator_suspend_user(p_user_id uuid, p_reason text) from anon;
revoke execute on function operator_unsuspend_user(p_user_id uuid, p_reason text) from anon;
revoke execute on function org_runs_document_checks(p_org_id uuid) from anon;
revoke execute on function properties_under_node(p_node_id uuid) from anon;
revoke execute on function provision_org(p_name text, p_delivery_brand text, p_admin_email text, p_admin_name text, p_reason text, p_token_hash text) from anon;
revoke execute on function purge_expired_applications() from anon, authenticated;
revoke execute on function raise_rent_charge(p_lease_id uuid, p_period_start date, p_period_end date, p_due_date date) from anon;
revoke execute on function recognise_vendor_payable(p_payment_id uuid) from anon, authenticated;
revoke execute on function record_application_approval(p_application_id uuid, p_reason text, p_invite_token_hash text) from anon;
revoke execute on function record_application_info_request(p_application_id uuid, p_reason text, p_token_hash text, p_expires_at timestamp with time zone) from anon;
revoke execute on function record_application_recommendation(p_application_id uuid, p_approve boolean, p_reason text) from anon;
revoke execute on function record_application_rejection(p_application_id uuid, p_reason text) from anon;
revoke execute on function record_collection(p_intent_id uuid, p_amount_verified numeric, p_paid_at timestamp with time zone) from anon, authenticated;
revoke execute on function record_opening_balance(p_bank_account_id uuid, p_as_of date, p_allocations jsonb) from anon;
revoke execute on function record_remittance_outcome(p_id uuid, p_status remittance_status, p_message text) from anon, authenticated;
revoke execute on function record_remittance_sent(p_id uuid, p_transfer_code text, p_sent_at timestamp with time zone) from anon, authenticated;
revoke execute on function reject_vendor_application(p_application_id uuid, p_notes text) from anon;
revoke execute on function remember_conversation(p_org_id uuid, p_channel text, p_sender_ref text, p_ticket_id uuid, p_awaiting text, p_hours integer) from anon, authenticated;
revoke execute on function renew_lease(p_lease_id uuid, p_months integer) from anon;
revoke execute on function reset_org_permissions_to_b7(p_org_id uuid) from anon;
revoke execute on function resolve_chat_sender(p_org_id uuid, p_sender_ref text) from anon, authenticated;
revoke execute on function restore_asset(p_asset_id uuid) from anon;
revoke execute on function retire_evaluation_criterion(p_id uuid) from anon;
revoke execute on function retire_org(p_org_id uuid, p_reason text) from anon;
revoke execute on function retire_org_node(p_node_id uuid) from anon;
revoke execute on function retire_property(p_property_id uuid) from anon;
revoke execute on function retire_unit(p_unit_id uuid) from anon;
revoke execute on function run_reconciliation(p_bank_account_id uuid, p_as_of_date date) from anon;
revoke execute on function seed_b7_permissions(p_org_id uuid) from anon, authenticated;
revoke execute on function seed_org_hierarchy(p_org_id uuid) from anon, authenticated;
revoke execute on function set_member_active(p_user_id uuid, p_active boolean) from anon;
revoke execute on function set_org_domain(p_org_id uuid, p_domain text, p_reason text) from anon;
revoke execute on function set_property_application_state(p_property_id uuid, p_state text, p_note text) from anon;
revoke execute on function set_role_permission(p_org_id uuid, p_role user_role, p_capability text, p_granted boolean) from anon;
revoke execute on function set_ticket_urgency_by_reporter(p_org_id uuid, p_ticket_id uuid, p_sender_ref text, p_urgency text) from anon, authenticated;
revoke execute on function submit_vendor_evaluation(p_ticket_id uuid, p_source text, p_responses jsonb) from anon;
revoke execute on function ticket_attachment_deletable(p_ticket_id uuid, p_uploaded_by uuid) from anon;
revoke execute on function unretire_org(p_org_id uuid, p_reason text) from anon;
revoke execute on function update_my_notification_prefs(p_phone text, p_telegram_chat_id text, p_email boolean, p_whatsapp boolean, p_sms boolean, p_telegram boolean) from anon;

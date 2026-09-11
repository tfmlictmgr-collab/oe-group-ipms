-- Two roles the board added on 29 July 2026.
--
--   `executive`         — the MD of TFML and the Managing Partner of OEA. One enum
--                         value with a brand-aware label, exactly as facility_manager
--                         reads "Facilities Manager" on TFML and "Properties
--                         Manager" on OEA. Oversight: sees everything, co-holds
--                         payment approval, and deliberately CANNOT execute a
--                         remittance.
--   `regional_manager`  — decentralised FM/PM administration. A manager attached to
--                         a REGION or PROJECT node with limited administrative
--                         functions bounded to that subtree.
--
-- ALTER TYPE ... ADD VALUE cannot be USED in the transaction that adds it, and the
-- migration runner wraps each file in one. Hence the split, exactly as 0037 did
-- for `viewer`: this file adds the values and 0072 uses them.

alter type user_role add value if not exists 'executive';
alter type user_role add value if not exists 'regional_manager';

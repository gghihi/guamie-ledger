DELETE FROM ledger_former_members; DELETE FROM line_drafts; DELETE FROM line_bindings; DELETE FROM line_bind_codes; DELETE FROM line_push_usage; DELETE FROM push_subscriptions; DELETE FROM loan_events; DELETE FROM loans; DELETE FROM ledgers; DELETE FROM sessions; DELETE FROM invite_codes; DELETE FROM users;
INSERT INTO users (id,google_sub,email,display_name) VALUES ('test-A','g-test-A','a@example.com','測試呱呱');
INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ('s-A','test-A','SplYzMrO6wy6Te4GPiTNCELIbKulO-vGkdHwVZDueNA','2099-01-01T00:00:00.000Z');
INSERT INTO users (id,google_sub,email,display_name) VALUES ('test-B','g-test-B','b@example.com','測試咩咩');
INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ('s-B','test-B','buHaSIaQreAQWDBmrpLzK6bcZgpVZur0FCGbTBsntvc','2099-01-01T00:00:00.000Z');
INSERT INTO users (id,google_sub,email,display_name) VALUES ('test-C','g-test-C','c@example.com','測試路人');
INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ('s-C','test-C','w-sblufusl98pb14dskjUoa3haPgPcndCM6QxpoIm4o','2099-01-01T00:00:00.000Z');

-- Send one iMessage.  Arguments: the number in E.164, then the message body.
--
-- Both are passed as ARGUMENTS rather than pasted into a script string, so the
-- message text is never parsed as AppleScript however it is written — an
-- apostrophe or a quotation mark in someone's message cannot change what runs.
--
-- Messages renamed "account" to "service" and "buddy" to "participant" across
-- macOS versions, so both spellings are tried before giving up.
on run argv
	if (count of argv) < 2 then error "usage: send.applescript <+E164> <message>"
	set targetPhone to item 1 of argv
	set messageBody to item 2 of argv

	tell application "Messages"
		set svc to missing value
		try
			set svc to 1st service whose service type = iMessage
		end try
		if svc is missing value then
			try
				set svc to 1st account whose service type = iMessage
			end try
		end if
		if svc is missing value then
			error "No iMessage account is signed in on this Mac. Open Messages and sign in, then try again."
		end if

		try
			send messageBody to participant targetPhone of svc
		on error participantError
			try
				send messageBody to buddy targetPhone of svc
			on error buddyError
				error "iMessage would not send to " & targetPhone & " — " & buddyError
			end try
		end try
	end tell
	return "sent"
end run

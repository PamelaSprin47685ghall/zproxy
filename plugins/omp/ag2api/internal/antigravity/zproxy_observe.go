package antigravity

// ZProxyNotify delivers one recorded account read to the observer the caller
// installed. The cold start records the directory without notifying, so a
// caller that needs the catalog it just read hands it over here instead of
// reading a copy the initialization no longer carries.
func ZProxyNotify(client *Client, observed Observed) {
	client.notify(observed)
}

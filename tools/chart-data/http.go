package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// notFoundError marks a URL the repository indexes but no longer hosts, which is
// permanent and recorded, unlike a transient failure which is retried next run.
type notFoundError struct{ url string }

func (e *notFoundError) Error() string { return fmt.Sprintf("404 Not Found: %s", e.url) }

func isNotFound(err error) bool {
	var missing *notFoundError
	return errors.As(err, &missing)
}

var client = &http.Client{Timeout: 2 * time.Minute}

// fetch reads a URL, retrying the failures that tend to be the network's fault.
func fetch(url string) ([]byte, error) {
	const attempts = 3

	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		body, err := get(url)
		if err == nil {
			return body, nil
		}
		if isNotFound(err) {
			return nil, err
		}
		lastErr = err
		if attempt < attempts {
			time.Sleep(time.Duration(attempt) * time.Second)
		}
	}
	return nil, lastErr
}

func get(url string) ([]byte, error) {
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "rancher-helm-playground-chart-data")

	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	switch {
	case response.StatusCode == http.StatusNotFound:
		return nil, &notFoundError{url: url}
	case response.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("%s: %s", url, response.Status)
	}

	return io.ReadAll(response.Body)
}

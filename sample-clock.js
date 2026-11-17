// Keep a single deadline pending while the page is throttled or suspended.
self.onmessage = ({ data: interval }) => {
  setTimeout(() => self.postMessage(null), interval);
};

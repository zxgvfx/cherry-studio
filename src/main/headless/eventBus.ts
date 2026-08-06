type HeadlessEventPublisher = (event: string, payload: unknown) => void

let publisher: HeadlessEventPublisher | undefined

export function setHeadlessEventPublisher(next: HeadlessEventPublisher | undefined): void {
  publisher = next
}

/** No-op in the normal desktop process; forwards to `/events` in headless mode. */
export function publishHeadlessEvent(event: string, payload: unknown): void {
  if (process.env.CHERRY_HEADLESS === '1') publisher?.(event, payload)
}

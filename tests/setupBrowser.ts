/** Append a real element to the browser document for one test. */
export function buildElement(tag = 'div'): HTMLElement {
	const element = document.createElement(tag)
	document.body.append(element)
	return element
}

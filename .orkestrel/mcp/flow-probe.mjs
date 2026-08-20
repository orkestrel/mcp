import { PassThrough } from 'node:stream'

// Q1: does a bare resume() leave readableFlowing true with zero data listeners?
const a = new PassThrough()
console.log('A0 flowing=%s listeners=%d', a.readableFlowing, a.listenerCount('data'))
a.resume()
console.log('A1 after resume(): flowing=%s listeners=%d', a.readableFlowing, a.listenerCount('data'))

// Q1b: attach then detach a data listener — flowing state afterwards?
const b = new PassThrough()
const handler = () => {}
b.on('data', handler)
console.log('B1 after on(data): flowing=%s listeners=%d', b.readableFlowing, b.listenerCount('data'))
b.removeListener('data', handler)
console.log('B2 after removeListener: flowing=%s listeners=%d', b.readableFlowing, b.listenerCount('data'))

// Q2: does on('data') after an explicit pause() restart the flow?
const c = new PassThrough()
c.pause()
let delivered = 0
c.on('data', () => { delivered += 1 })
c.write('x')
setTimeout(() => {
  console.log('C after pause() then on(data) then write: delivered=%d flowing=%s', delivered, c.readableFlowing)

  // Q3: the starvation case — two readers, one pauses
  const d = new PassThrough()
  let first = 0
  let second = 0
  const h1 = () => { first += 1 }
  const h2 = () => { second += 1 }
  d.on('data', h1)
  d.on('data', h2)
  d.write('one')
  setTimeout(() => {
    d.removeListener('data', h1)
    d.pause()
    d.write('two')
    setTimeout(() => {
      console.log('D two readers, first removed then pause(): first=%d second=%d flowing=%s', first, second, d.readableFlowing)
      console.log('D second reader starved after the first pauses: %s', second === 1 ? 'YES' : 'no')
    }, 20)
  }, 20)
}, 20)

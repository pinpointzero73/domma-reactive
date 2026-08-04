# domma-reactive

Dependency-tracked reactivity: derivations discover which state they actually read, so a write re-runs exactly the work
that depends on it. This is the reactive core of [Domma](https://github.com/pinpointzero73/domma), published separately
so it can be used on its own.

## Install

```bash
npm install domma-reactive
```

## Use

```javascript
import {observable, computed, effect} from 'domma-reactive';

const price = observable(10);
const qty   = observable(3);

const total = computed(() => price.value * qty.value);

effect(() => console.log('total is', total.get()));

qty.value = 4;   // effect re-runs on the next microtask
```

Updates are batched: several writes in one tick produce a single re-run.

## Licence

MIT.

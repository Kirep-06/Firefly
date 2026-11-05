---
title: LRU 算法：原理与 Go 实现
published: 2026-11-05
description: 对比 FIFO、LFU 和 LRU 三种缓存淘汰策略，并使用 Go 的 map 与双向链表实现 LRU 缓存。
tags: [Go, 缓存, 算法]
category: 技术
draft: false
---

缓存容量有限时，需要决定淘汰哪些记录。常见的淘汰策略包括 FIFO、LFU 和 LRU。

## FIFO（First In First Out）

先进先出，淘汰缓存中最早添加的记录。FIFO 认为，最早添加的记录不再被使用的可能性比刚添加的记录大。

它的实现很简单：创建一个队列，新记录添加到队尾；内存不够时，淘汰队首。但在一些场景下，最早添加的记录也可能是最常被访问的。它仍会因为停留时间过长而被淘汰，之后又被重新加入缓存，导致缓存命中率降低。

## LFU（Least Frequently Used）

最少使用，淘汰访问次数最少的记录。LFU 认为，过去被多次访问的数据，将来被访问的可能性也更高。

实现时需要记录每条数据的访问次数，并在访问后更新计数；淘汰时选择访问次数最少的记录。维护这些计数和顺序会带来额外的空间与更新成本。此外，LFU 容易受历史访问量影响：某条数据曾经非常热门，即使后来几乎不再被访问，也可能长期留在缓存中。

## LRU（Least Recently Used）

最近最少使用，淘汰最长时间没有被访问的记录。相较于只看加入时间的 FIFO 和累计访问次数的 LFU，LRU 更关注最近的使用情况。

可以用 **map + 双向链表** 实现：

- **map** 存储键到链表节点的映射，查询、插入和删除平均为 $O(1)$。
- **双向链表** 维护使用顺序。访问或更新记录时，将节点移到链表头部；插入新记录时也放在头部。链表尾部就是最近最少使用的记录。
- 两者结合，查询、插入和淘汰的时间复杂度均为 $O(1)$，空间复杂度为 $O(n)$。

### Go 实现

下面的实现使用 `container/list` 管理双向链表，并按键和值占用的字节数控制容量。`capacity <= 0` 时不限制容量。

```go
package main

import "container/list"

type entry struct {
	key   string
	value Value
}

type Value interface {
	Len() int
}

type LRUCache struct {
	capacity int64
	nbytes   int64
	items    *list.List
	kvcache  map[string]*list.Element
}

func NewLRUCache(capacity int64) *LRUCache {
	return &LRUCache{
		capacity: capacity,
		items:    list.New(),
		kvcache:  make(map[string]*list.Element),
	}
}

func (c *LRUCache) Get(key string) (value Value, ok bool) {
	if ele, ok := c.kvcache[key]; ok {
		c.items.MoveToFront(ele)
		kv := ele.Value.(*entry)
		return kv.value, true
	}
	return
}

func (c *LRUCache) Add(key string, value Value) {
	if ele, ok := c.kvcache[key]; ok {
		c.items.MoveToFront(ele)
		kv := ele.Value.(*entry)
		c.nbytes += int64(value.Len()) - int64(kv.value.Len())
		kv.value = value
	} else {
		ele := c.items.PushFront(&entry{key, value})
		c.kvcache[key] = ele
		c.nbytes += int64(len(key)) + int64(value.Len())
	}
	for c.capacity > 0 && c.capacity < c.nbytes {
		c.RemoveOldest()
	}
}

func (c *LRUCache) RemoveOldest() {
	ele := c.items.Back()
	if ele != nil {
		c.items.Remove(ele)
		kv := ele.Value.(*entry)
		delete(c.kvcache, kv.key)
		c.nbytes -= int64(len(kv.key)) + int64(kv.value.Len())
	}
}
```

LRU 根据近期访问情况淘汰数据，可以避免 LFU 中历史热点数据长期占据缓存的问题。

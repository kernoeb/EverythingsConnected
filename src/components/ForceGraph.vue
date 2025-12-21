<script setup lang="ts">
import dagre from '@dagrejs/dagre'
import { watchDebounced } from '@vueuse/core'
import * as d3 from 'd3'
import { onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{
  nodes: any[]
  links: any[]
  options: {
    layout?: string // 'force' | 'dagre'
    showImages: boolean
    popSize: boolean
    showLeaves: boolean
  }
}>()

const emit = defineEmits(['nodeClick', 'linkClick'])
const svgRef = ref<SVGSVGElement | null>(null)

let simulation: d3.Simulation<any, any> | null = null
let width = window.innerWidth
let height = window.innerHeight

// D3 Selections
let svg: d3.Selection<SVGSVGElement, unknown, null, undefined>
let g: d3.Selection<SVGGElement, unknown, null, undefined>
let linkGroup: d3.Selection<SVGGElement, unknown, null, undefined>
let nodeGroup: d3.Selection<SVGGElement, unknown, null, undefined>
let linkSelection: d3.Selection<SVGLineElement, any, SVGGElement, unknown>
let nodeSelection: d3.Selection<SVGGElement, any, SVGGElement, unknown>

// Store previous node positions to prevent "explosion" on update
const nodePositions = new Map<string, { x: number, y: number, vx?: number, vy?: number, fx?: number | null, fy?: number | null, isPinned?: boolean }>()

const previousLayout = ref(props.options.layout)

function getRadius(d: any) {
  return props.options.popSize ? Math.max(d.popularity || 10, 20) : 40
}

onMounted(() => {
  if (!svgRef.value) return

  svg = d3.select(svgRef.value).attr('viewBox', [0, 0, width, height])

  // Background
  svg.append('rect')
    .attr('width', width)
    .attr('height', height)
    .attr('fill', 'transparent')

  g = svg.append('g').style('will-change', 'transform')

  // Create Layers: Links first (bottom), Nodes second (top)
  linkGroup = g.append('g').attr('class', 'links')
  nodeGroup = g.append('g').attr('class', 'nodes')

  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 4])
    .on('zoom', event => g.attr('transform', event.transform))

  svg.call(zoom).on('dblclick.zoom', (event) => {
    // Check if we clicked on the background (svg or rect)
    // The event.target will be the element clicked.
    // If we click a node, we probably don't want to reset zoom (though standard d3 double click might still fire).
    // Since nodes have their own click handlers, and we might want to avoid conflict.
    // However, simpler is just to reset zoom if it wasn't swallowed by something else.
    // D3 zoom usually attaches to the SVG.
    svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity)
  })

  // Initialize Simulation
  simulation = d3.forceSimulation()
    .force('charge', d3.forceManyBody().strength(-1000))
    .force('center', d3.forceCenter(width / 2, height / 2).strength(0.05))
    .force('collide', d3.forceCollide().radius((d: any) => getRadius(d) + 20).iterations(2))
    .force('link', d3.forceLink().id((d: any) => d.id).distance(200))
    .velocityDecay(0.4)

  window.addEventListener('resize', handleResize)

  // Watch for data changes
  watchDebounced(() => [props.nodes.length, props.links.length, props.options], updateGraph, { deep: true, immediate: true, debounce: 100 })
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  if (simulation) simulation.stop()
})

function handleResize() {
  width = window.innerWidth
  height = window.innerHeight
  svg.attr('viewBox', [0, 0, width, height])
  if (simulation && props.options.layout !== 'dagre') {
    simulation.force('center', d3.forceCenter(width / 2, height / 2))
    simulation.alpha(0.3).restart()
  }
}

function updateGraph() {
  if (!simulation) return

  const layoutChanged = props.options.layout !== previousLayout.value

  // 1. Snapshot current positions before we replace data
  simulation.nodes().forEach((n) => {
    nodePositions.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy, fx: n.fx, fy: n.fy, isPinned: n.isPinned })
  })

  // 2. Prepare CLEAN data (Strip Vue Proxies and D3 circular refs)
  // We use the ID to filter.
  // IMPORTANT: We create NEW objects so D3 doesn't fight with Vue.

  const activeNodes = props.nodes.map(n => ({ ...n })) // Shallow clone properties
  const activeNodeIds = new Set(activeNodes.map(n => n.id))

  // Filter and Clean Links
  // We explicitly extract the ID string for source/target to ensure D3 re-links them correctly.
  const activeLinks = props.links
    .filter((l) => {
      const s = typeof l.source === 'object' ? l.source.id : l.source
      const t = typeof l.target === 'object' ? l.target.id : l.target
      return activeNodeIds.has(s) && activeNodeIds.has(t)
    })
    .map(l => ({
      ...l,
      // Force reset to ID strings so D3 can find them in the new 'activeNodes' array
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target,
    }))

  // 3. Restore positions if they exist
  activeNodes.forEach((n) => {
    const prev = nodePositions.get(n.id)
    if (prev) {
      n.x = prev.x
      n.y = prev.y
      n.vx = prev.vx
      n.vy = prev.vy
      n.fx = prev.fx
      n.fy = prev.fy
      // Restore pinned state, unless layout changed (force unpin)
      n.isPinned = layoutChanged ? false : prev.isPinned
    } else {
      // Spawn near center
      n.x = width / 2 + (Math.random() - 0.5) * 50
      n.y = height / 2 + (Math.random() - 0.5) * 50
    }
  })

  // 4. Update Simulation Data
  simulation.nodes(activeNodes).on('tick', ticked)

  // Update Link Force
  // NOTE: activeLinks contains string IDs for source/target now.
  // D3 will mutate them into object references.
  const linkForce = simulation.force('link') as d3.ForceLink<any, any>
  linkForce.links(activeLinks)

  // Dynamic repulsion based on size
  simulation.force('charge', d3.forceManyBody().strength((d: any) => -15 * getRadius(d)))
  simulation.force('collide', d3.forceCollide().radius((d: any) => getRadius(d) * 1.5))

  // 5. Render Links
  linkSelection = linkGroup.selectAll<SVGLineElement, any>('.link')
    .data(activeLinks, (d: any) => `${d.source.id || d.source}-${d.target.id || d.target}`)

  linkSelection.exit().remove()

  const linkEnter = linkSelection.enter().append('line').attr('class', 'link stroke-base-content/20').attr('stroke-width', 1.5).on('click', (event, d) => emit('linkClick', d))

  linkSelection = linkEnter.merge(linkSelection)

  // 6. Render Nodes
  nodeSelection = nodeGroup.selectAll<SVGGElement, any>('.node')
    .data(activeNodes, (d: any) => d.id)

  nodeSelection.exit().transition().duration(500).attr('opacity', 0).remove()

  const nodeEnter = nodeSelection.enter().append('g').attr('class', 'node cursor-pointer').call(d3.drag<SVGGElement, any>()
    .on('start', dragstarted)
    .on('drag', dragged)
    .on('end', dragended),
  ).on('click', (event, d) => emit('nodeClick', d)).on('mouseover', function () {
    d3.select(this).select('circle').transition().duration(200).attr('stroke-width', 4).attr('stroke', '#1db954')
  }).on('mouseout', function (event, d) {
    const color = d.source === 'searched' ? '#FFD700' : (d.source === 'clicked' ? '#1db954' : 'rgba(0,0,0,0.1)')
    const width = (d.source === 'searched' || d.source === 'clicked') ? 3 : 2
    d3.select(this).select('circle').transition().duration(200).attr('stroke-width', width).attr('stroke', color)
  })

  nodeEnter.append('title').text('Click to expand connections')

  // Circle Base
  nodeEnter.append('circle')
    .attr('stroke', (d) => {
      if (d.source === 'searched') return '#FFD700' // Gold for searched
      if (d.source === 'clicked') return '#1db954' // Green for clicked
      return 'rgba(0,0,0,0.1)'
    })
    .attr('stroke-width', d => (d.source === 'searched' || d.source === 'clicked') ? 3 : 2)

  // Image Clip
  nodeEnter.append('clipPath')
    .attr('id', d => `clip-${d.id}`)
    .append('circle')

  // Image
  nodeEnter.append('image')
    .attr('preserveAspectRatio', 'xMidYMid slice')
    .style('pointer-events', 'none')

  // Text (Name)
  nodeEnter.append('text')
    .attr('class', 'name fill-white font-bold select-none pointer-events-none text-wrap')
    .attr('stroke', '#000')
    .attr('stroke-width', '3px')
    .attr('paint-order', 'stroke')
    .attr('text-anchor', 'middle')
    .attr('dy', '-0.2em') // Shift up slightly
    .style('font-family', '\'Rubik Mono One\', sans-serif')

  // Text (Connections)
  nodeEnter.append('text')
    .attr('class', 'connections fill-gray-200 select-none pointer-events-none')
    .attr('stroke', '#000')
    .attr('stroke-width', '3px')
    .attr('paint-order', 'stroke')
    .attr('text-anchor', 'middle')
    .attr('dy', '1.4em') // Shift down
    .style('font-family', 'sans-serif')
    .style('font-weight', 'bold')

  nodeSelection = nodeEnter.merge(nodeSelection)

  // Update Visual Attributes
  nodeSelection.select('circle')
    .transition()
    .duration(300)
    .attr('r', d => getRadius(d))
    .attr('fill', d => props.options.showImages ? '#2a2a2a' : d3.interpolateRainbow(d.priority / 6))

  if (props.options.showImages) {
    nodeSelection.select('clipPath circle').attr('r', d => getRadius(d))
    nodeSelection.select('image')
      .attr('visibility', 'visible')
      .attr('xlink:href', d => d.image)
      .attr('clip-path', d => `url(#clip-${d.id})`)
      .attr('x', d => -getRadius(d))
      .attr('y', d => -getRadius(d))
      .attr('width', d => getRadius(d) * 2)
      .attr('height', d => getRadius(d) * 2)
  } else {
    nodeSelection.select('image').attr('visibility', 'hidden')
  }

  nodeSelection.select('text.name')
    .text(d => d.name)
    .style('font-size', (d) => {
      const r = getRadius(d)
      const len = d.name ? d.name.length : 10
      // Slightly smaller multiplier (2.2 instead of 2.5)
      return `${Math.min(r / 1.7, (r * 2.2) / len)}px`
    })

  nodeSelection.select('text.connections')
    .text(d => d.degree)
    .style('font-size', d => `${getRadius(d) / 3}px`)

  // --- LAYOUT LOGIC ---
  if (props.options.layout === 'dagre') {
    simulation.stop()
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', align: 'DL', nodesep: 50, ranksep: 150, marginx: 50, marginy: 50 })
    g.setDefaultEdgeLabel(() => ({}))

    activeNodes.forEach((node) => {
      const r = getRadius(node)
      g.setNode(node.id, { width: r * 2, height: r * 2 })
    })

    activeLinks.forEach((link) => {
      // activeLinks now has objects for source/target if D3 processed them,
      // OR strings if it's fresh.
      // Safe access:
      const s = (link.source as any).id || link.source
      const t = (link.target as any).id || link.target
      g.setEdge(s, t)
    })

    dagre.layout(g)

    // Apply Dagre positions
    // Center the graph
    const graphLabel = g.graph()
    const offsetX = (width - graphLabel.width!) / 2
    const offsetY = (height - graphLabel.height!) / 2

    activeNodes.forEach((node) => {
      const pos = g.node(node.id)
      if (pos) {
        // Animate or set?
        // Let's set target positions and use a transition if we want, or just tick.
        // For simplicity and performance, we'll set x/y and fx/fy to lock them.
        node.fx = pos.x + offsetX
        node.fy = pos.y + offsetY
        node.x = node.fx
        node.y = node.fy
      }
    })

    // Manually tick once to update DOM
    ticked()
  } else {
    // FORCE LAYOUT
    // Unlock nodes (unless dragging or pinned)
    activeNodes.forEach((node) => {
      if (!node.isPinned) {
        node.fx = null
        node.fy = null
      }
    })

    // Restart
    simulation.alpha(0.5).restart()
  }

  previousLayout.value = props.options.layout
}

function ticked() {
  if (linkSelection) {
    linkSelection
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y)
  }

  if (nodeSelection) {
    nodeSelection.attr('transform', d => `translate(${d.x},${d.y})`)
  }
}

function dragstarted(event: any) {
  event.subject.fx = event.subject.x
  event.subject.fy = event.subject.y
}

function dragged(event: any) {
  // Always restart simulation on drag to ensure responsiveness
  simulation?.alphaTarget(0.3).restart()
  event.subject.fx = event.x
  event.subject.fy = event.y
}

function dragended(event: any) {
  if (!event.active && simulation) simulation.alphaTarget(0)
  // Do NOT release fx/fy to pin the node
  // event.subject.fx = null;
  // event.subject.fy = null;
  event.subject.isPinned = true
}
</script>

<template>
  <div class="w-full h-full bg-base-100 overflow-hidden relative">
    <svg ref="svgRef" class="w-full h-full block" />
    <div class="absolute bottom-4 right-4 text-xs text-base-content/30 pointer-events-none select-none">
      Double-click blank space to reset zoom
    </div>
  </div>
</template>

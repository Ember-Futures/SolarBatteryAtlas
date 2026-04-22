#!/usr/bin/env python3
"""
Update scrollytelling sections to new 7-part narrative
"""

# New section content
sections = {
    "section-1": {
        "data-section": "widespread",
        "heading": "1. Baseload Solar is Widespread",
        "content": """
                    <p class="scrolly-drop-cap">In the deserts of Abu Dhabi, the Masdar One project demonstrates what solar-plus-storage can achieve: a 6-megawatt solar array paired with 20 megawatt-hours of battery storage, delivering power with over 99% uptime. Impressive, certainly—but many assume such performance is confined to the world's sunniest locales.</p>
                    
                    <p>The reality is far more optimistic. That same configuration—6 MW of solar, 20 MWh of batteries—would achieve capacity factors above 90% not just in the Middle East, but across vast swaths of the tropics and subtropics. From Southern Europe to East Asia, from the American Southwest to sub-Saharan Africa, the Masdar blueprint is replicable.</p>
                    
                    <p>The map reveals the extent: reliable baseload solar is not a niche technology reserved for desert kingdoms. It is a mainstream option for billions.</p>
"""
    },
    "section-2": {
        "data-section": "battery-capacity",
        "heading": "2. Batteries Make All the Difference",
        "content": """
                    <p>With no battery storage at all, even the sunniest locations falter after sunset. Solar panels alone cannot provide baseload power. But watch how the world transforms as battery capacity increases.</p>
                    
                    <aside class="scrolly-callout">
                        <span class="material-symbols-outlined text-accent">battery_charging_full</span>
                        <p>The map cycles through battery capacities from 0 to 24 MWh, revealing how storage expands the viable zone for baseload solar.</p>
                    </aside>
                    
                    <p>At 8 MWh—roughly a night's worth of backup—the tropics and subtropics light up. At 16 MWh, Southern Europe and much of China become viable. By 24 MWh, only the polar extremes remain off-limits.</p>
                    
                    <p>Battery capacity is the difference between solar as a supplement and solar as a foundation.</p>
"""
    },
    "section-3": {
        "data-section": "battery-shadow",
        "heading": "3. Batteries Make the Sun Shine After Dark",
        "content": """
                    <p>Think of battery storage as the sun's shadow—a reservoir of energy that follows the daylight hours and continues into the night. During the day, excess solar generation charges the battery; after sunset, the battery discharges to meet demand.</p>
                    
                    <p>The chart below shows a representative week for a location with strong solar potential. Solar generation peaks mid-day, but the battery seamlessly bridges the gap, delivering power through the evening and into the early morning.</p>
                    
                    <p>This temporal shifting—storing surplus daylight energy for nighttime use—is what transforms intermittent solar into reliable baseload power.</p>
"""
    },
    "section-4": {
        "data-section": "cheap-populous",
        "heading": "4. Cheap Exactly Where People Live",
        "content": """
                    <p>The best solar resources often lie in unpopulated deserts—far from electricity demand. Yet when overlaying population density onto the cost map, a different picture emerges.</p>
                    
                    <p>At today's prices—roughly $600 per kilowatt of solar and $120 per kilowatt-hour of batteries—baseload solar can be delivered for <span class="data-link" data-view="lcoe" data-value="60-90">$60-90 per megawatt-hour</span> across much of the developing world. India, Indonesia, Nigeria, Brazil: regions with both dense populations <em>and</em> competitive solar economics.</p>
                    
                    <p>The sweet spot is not as remote as the deserts suggest. More than <span class="data-link" data-stat="pop-4b" data-chart="population-cf">4 billion people</span> live in areas where baseload solar is both technically viable and economically competitive.</p>
"""
    },
    "section-5": {
        "data-section": "cheap-access",
        "heading": "5. Cheap Where Electricity Access is Lacking",
        "content": """
                    <p>For nearly a billion people, the question is not whether solar can compete with existing power plants—it is whether any reliable electricity can be had at all. Across sub-Saharan Africa and parts of South Asia, grid reliability remains woefully low.</p>
                    
                    <p>Here is the cruel irony: the regions with the weakest grids often have the strongest solar resources. And it is precisely in these regions that baseload solar economics are most compelling.</p>
                    
                    <p>For communities where the grid delivers power less than half the time, a solar-plus-battery system rated at 90% capacity factor would represent a quantum leap in energy access—<em>and</em> cost less than extending the existing grid.</p>
"""
    },
    "section-6": {
        "data-section": "better-uptime",
        "heading": "6. Better Uptime Than Many Grids",
        "content": """
                    <p>Even without diesel backup or grid connection, a standalone solar-plus-battery system can outperform many national grids. In regions where grid uptime averages 60-80%, a solar system achieving 85-95% capacity factor is not merely competitive—it is superior.</p>
                    
                    <p>The map highlights this often-overlooked fact: green regions indicate where solar CF exceeds local grid reliability. For hundreds of millions, baseload solar is not an alternative—it is an <em>upgrade</em>.</p>
                    
                    <p>The distribution chart reinforces the point: vast populations live in regions where solar already beats the grid, no fossil backup required.</p>
"""
    },
    "section-7": {
        "data-section": "planned-capacity",
        "heading": "7. Cheap Where New Capacity is Planned",
        "content": """
                    <p>The climate case for solar is clearest where it can directly displace dirty fuels. And remarkably, the world's pipeline of new power plants—announced projects and those under construction—aligns almost perfectly with the best baseload solar economics.</p>
                    
                    <p>The world still plans to build over <span class="data-link" data-stat="coal-2000gw" data-chart="fossil-displacement">2,000 gigawatts</span> of new thermal capacity. India, Southeast Asia, sub-Saharan Africa: all regions with excellent solar potential, all planning massive fossil buildouts.</p>
                    
                    <p>The chart below shows the cumulative capacity of planned projects, sorted by the LCOE of baseload solar in their respective regions. The message is stark: hundreds of gigawatts of fossil capacity could be displaced by cheaper, cleaner solar baseload—if we act now.</p>
"""
    }
}

# Read the HTML file
with open('index.html', 'r') as f:
    html = f.read()

# Replace each section
import re

for section_id, data in sections.items():
    # Pattern to match section
    pattern = rf'(<section class="scrolly-section" data-section="[^"]*" id="{section_id}">.*?<h2 class="scrolly-heading">)[^<]*(</h2>.*?)(</section>)'
    
    # Build replacement
    new_section_tag = f'<section class="scrolly-section" data-section="{data["data-section"]}" id="{section_id}">'
    new_content = f'''{new_section_tag}
                <div class="scrolly-section-content">
                    <h2 class="scrolly-heading">{data["heading"]}</h2>
{data["content"]}                </div>
            </section>'''
    
    # Find and replace
    section_pattern = rf'<section class="scrolly-section" data-section="[^"]*" id="{section_id}">.*?</section>'
    html = re.sub(section_pattern, new_content, html, flags=re.DOTALL)

# Write back
with open('index.html', 'w') as f:
    f.write(html)

print("Sections updated successfully!")

/**
 * Cached Ontario 511 response, trimmed to the 401 corridor. Kept as a JS module
 * rather than JSON so it imports identically under Node (headless tests) and
 * Vite — Node 24 needs an import attribute for JSON and Vite does not.
 */
export default [
  {
    ID: 'fix-401-1',
    RoadwayName: 'Highway 401',
    DirectionOfTravel: 'Eastbound',
    Description: 'Collision blocking the right lane near Highway 8. Expect delays.',
    EventType: 'accidentsAndIncidents',
    IsFullClosure: false,
    Latitude: 43.3661,
    Longitude: -80.3011,
    LastUpdated: 1757145600,
  },
  {
    ID: 'fix-401-2',
    RoadwayName: 'Highway 401',
    DirectionOfTravel: 'Both',
    Description: 'Construction: left lane closed for resurfacing between Tilbury and Chatham.',
    EventType: 'roadwork',
    IsFullClosure: false,
    Latitude: 42.3401,
    Longitude: -82.3102,
    LastUpdated: 1757142000,
  },
  {
    ID: 'fix-401-3',
    RoadwayName: 'Highway 401',
    DirectionOfTravel: 'Westbound',
    Description: 'Disabled tractor-trailer on the shoulder east of Woodstock.',
    EventType: 'accidentsAndIncidents',
    IsFullClosure: false,
    Latitude: 43.1339,
    Longitude: -80.7318,
    LastUpdated: 1757149200,
  },
  {
    ID: 'fix-401-4',
    RoadwayName: 'Highway 401',
    DirectionOfTravel: 'Both',
    Description: 'Blowing snow, reduced visibility. Winter driving conditions reported.',
    EventType: 'weatherCondition',
    IsFullClosure: false,
    Latitude: 42.6258,
    Longitude: -81.6021,
    LastUpdated: 1757138400,
  },
]

/**
 * CTRACK Field Definitions for ArcGIS Enterprise CDF
 * Maps MongoDB ctrack_data fields → Esri Feature Service field schema
 *
 * Esri field types:
 *   esriFieldTypeOID, esriFieldTypeString, esriFieldTypeInteger,
 *   esriFieldTypeDouble, esriFieldTypeDate, esriFieldTypeSmallInteger
 */

const FIELDS = [
  { name: '_oid',                    alias: 'ObjectID',              type: 'esriFieldTypeOID'          },
  { name: 'suid',                    alias: 'SUID',                  type: 'esriFieldTypeString',      length: 64  },
  { name: 'ship_name',              alias: 'Ship Name',             type: 'esriFieldTypeString',      length: 128 },
  { name: 'mmsi_number',            alias: 'MMSI',                  type: 'esriFieldTypeDouble'                   },
  { name: 'imo_no',                 alias: 'IMO Number',            type: 'esriFieldTypeInteger'                  },
  { name: 'nationality',            alias: 'Nationality Code',      type: 'esriFieldTypeInteger'                  },
  { name: 'ship_type',              alias: 'Ship Type (AIS)',       type: 'esriFieldTypeInteger'                  },
  { name: 'latitude',               alias: 'Latitude',              type: 'esriFieldTypeDouble'                   },
  { name: 'longitude',              alias: 'Longitude',             type: 'esriFieldTypeDouble'                   },
  { name: 'speed',                  alias: 'Speed (knots)',         type: 'esriFieldTypeDouble'                   },
  { name: 'course',                 alias: 'Course',                type: 'esriFieldTypeDouble'                   },
  { name: 'heading',                alias: 'Heading',               type: 'esriFieldTypeDouble'                   },
  { name: 'rate_of_turn',           alias: 'Rate of Turn',          type: 'esriFieldTypeInteger'                  },
  { name: 'navigational_status',    alias: 'Nav Status',            type: 'esriFieldTypeInteger'                  },
  { name: 'draught',                alias: 'Draught (m)',           type: 'esriFieldTypeInteger'                  },
  { name: 'total_vessel_length',    alias: 'Vessel Length (m)',     type: 'esriFieldTypeInteger'                  },
  { name: 'total_vessel_width',     alias: 'Vessel Width (m)',      type: 'esriFieldTypeInteger'                  },
  { name: 'length_bow',             alias: 'Length to Bow',         type: 'esriFieldTypeInteger'                  },
  { name: 'length_stream',          alias: 'Length to Stern',       type: 'esriFieldTypeInteger'                  },
  { name: 'width_port',             alias: 'Width to Port',         type: 'esriFieldTypeInteger'                  },
  { name: 'width_starboard',        alias: 'Width to Starboard',    type: 'esriFieldTypeInteger'                  },
  { name: 'threat_score',           alias: 'Threat Score',          type: 'esriFieldTypeInteger'                  },
  { name: 'vigilance_score',        alias: 'Vigilance Score',       type: 'esriFieldTypeInteger'                  },
  { name: 'css_track_quality',      alias: 'Track Quality',         type: 'esriFieldTypeInteger'                  },
  { name: 'css_track_status',       alias: 'Track Status',          type: 'esriFieldTypeInteger'                  },
  { name: 'css_track_class',        alias: 'Track Class',           type: 'esriFieldTypeInteger'                  },
  { name: 'csscategory',            alias: 'CSS Category',          type: 'esriFieldTypeInteger'                  },
  { name: 'cargo_type',             alias: 'Cargo Type',            type: 'esriFieldTypeInteger'                  },
  { name: 'no_of_surv',             alias: 'Number of Surveillance',type: 'esriFieldTypeInteger'                  },
  { name: 'no_contrib',             alias: 'Number of Contributors',type: 'esriFieldTypeInteger'                  },
  { name: 'toi_flag',               alias: 'TOI Flag',              type: 'esriFieldTypeSmallInteger'             },
  { name: 'sticky_flag',            alias: 'Sticky Flag',           type: 'esriFieldTypeSmallInteger'             },
  { name: 'nsc_validity_flag',      alias: 'NSC Validity Flag',     type: 'esriFieldTypeSmallInteger'             },
  { name: 'remarks',                alias: 'Remarks',               type: 'esriFieldTypeString',      length: 256 },
  { name: 'sensor_type_list',       alias: 'Sensor Type',           type: 'esriFieldTypeString',      length: 64  },
  { name: 'data_source',            alias: 'Data Source',           type: 'esriFieldTypeString',      length: 32  },
  { name: 'reported_time_info',     alias: 'Reported Time',         type: 'esriFieldTypeDate'                     },
  { name: 'created_time_info',      alias: 'Created Time',          type: 'esriFieldTypeDate'                     },
  { name: 'system_updated_time_info', alias: 'System Updated Time', type: 'esriFieldTypeDate'                     },
  { name: 'color',                  alias: 'Display Color',         type: 'esriFieldTypeString',      length: 16  },
];

/**
 * Nationality code → color mapping (matches server-side $switch)
 */
const NATIONALITY_COLORS = {
  273: '#FF0000', 419: '#e4e901', 501: '#00FF00', 502: '#FF8C00',
  503: '#1E90FF', 504: '#800080', 505: '#00CED1', 506: '#FF69B4',
  508: '#8B4513', 510: '#4682B4', 511: '#32CD32', 512: '#DC143C',
  514: '#FF4500', 515: '#4169E1', 516: '#2E8B57', 518: '#DAA520',
  519: '#9370DB', 520: '#20B2AA',
};

module.exports = { FIELDS, NATIONALITY_COLORS };

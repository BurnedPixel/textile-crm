// The closed-catalogue reference docs (config:colorchart / config:catalog /
// config:pricelist:tiendas) EXACTLY as loaded into production on 2026-08-15 —
// seeded in dev so ingress restrictions and the price prefill behave like the
// real app. Generated from the JSON files in docs/; regenerate, never hand-edit.
// Reference docs have no logic-module writer (they are plain config: documents,
// PUT to production the same way), so seeding them raw is the honest parallel.

export const CATALOG_DOCS = [
  {
    "_id": "config:colorchart",
    "type": "config",
    "chartName": "Carta de colores ML Textiles",
    "bands": {
      "1": "Blanco",
      "2": "Pasteles",
      "3": "Medios",
      "4": "Oscuros"
    },
    "colors": [
      {
        "code": "100",
        "name": "Blanco",
        "hex": "#f3f1ec"
      },
      {
        "code": "200",
        "name": "Amarillo",
        "hex": "#f9d66d"
      },
      {
        "code": "201",
        "name": "Amarillo maiz",
        "hex": "#f4bf5a"
      },
      {
        "code": "202",
        "name": "Amarillo colegial",
        "hex": "#f3dc8c"
      },
      {
        "code": "203",
        "name": "Crudo",
        "hex": "#ecdcce"
      },
      {
        "code": "204",
        "name": "Perla",
        "hex": "#cec3a3"
      },
      {
        "code": "205",
        "name": "Verde boa",
        "hex": "#6f6e50"
      },
      {
        "code": "206",
        "name": "Beige colegial",
        "hex": "#aa9378"
      },
      {
        "code": "207",
        "name": "Kaki",
        "hex": "#877569"
      },
      {
        "code": "208",
        "name": "Azul cielo",
        "hex": "#09b5dd"
      },
      {
        "code": "209",
        "name": "Celeste",
        "hex": "#59a2cf"
      },
      {
        "code": "210",
        "name": "Celeste colegial",
        "hex": "#426ea3"
      },
      {
        "code": "211",
        "name": "Gris lindo",
        "hex": "#737a8c"
      },
      {
        "code": "212",
        "name": "Rosa vieja",
        "hex": "#d85473"
      },
      {
        "code": "213",
        "name": "Rosado",
        "hex": "#ec7c90"
      },
      {
        "code": "214",
        "name": "Guayaba",
        "hex": "#de6366"
      },
      {
        "code": "215",
        "name": "Melon",
        "hex": "#e3906b"
      },
      {
        "code": "216",
        "name": "Salmon",
        "hex": "#e27a76"
      },
      {
        "code": "217",
        "name": "Lila",
        "hex": "#735a93"
      },
      {
        "code": "218",
        "name": "Verde agua",
        "hex": "#8cd7c0"
      },
      {
        "code": "219",
        "name": "Rosado bebe",
        "hex": "#ed97a5"
      },
      {
        "code": "220",
        "name": "Verde agua bebe",
        "hex": "#a6e0c3"
      },
      {
        "code": "221",
        "name": "Lila bebe",
        "hex": "#8f89a2"
      },
      {
        "code": "222",
        "name": "Celeste bebe",
        "hex": "#99aecb"
      },
      {
        "code": "223",
        "name": "Amarillo bebe",
        "hex": "#f5e394"
      },
      {
        "code": "300",
        "name": "Azul medio",
        "hex": "#024f93"
      },
      {
        "code": "301",
        "name": "Azul italo",
        "hex": "#294d88"
      },
      {
        "code": "302",
        "name": "Azul belmont",
        "hex": "#1c5283"
      },
      {
        "code": "303",
        "name": "Verde humo",
        "hex": "#584e4c"
      },
      {
        "code": "304",
        "name": "Kaki oscuro",
        "hex": "#877569"
      },
      {
        "code": "305",
        "name": "Melocoton",
        "hex": "#eb8971"
      },
      {
        "code": "306",
        "name": "Amarillo mantequilla",
        "hex": "#f6ce77"
      },
      {
        "code": "307",
        "name": "Verde musgo",
        "hex": "#355b63"
      },
      {
        "code": "308",
        "name": "Azul oceano",
        "hex": "#274d6c"
      },
      {
        "code": "309",
        "name": "Gris cemento",
        "hex": "#494d59"
      },
      {
        "code": "310",
        "name": "Verde oregano",
        "hex": "#516c65"
      },
      {
        "code": "311",
        "name": "Morado",
        "hex": "#242e61"
      },
      {
        "code": "312",
        "name": "Amarillo fortiplan",
        "hex": "#7c5e3c"
      },
      {
        "code": "313",
        "name": "Marron claro",
        "hex": "#4e4442"
      },
      {
        "code": "314",
        "name": "Oro",
        "hex": "#0795cd"
      },
      {
        "code": "315",
        "name": "Amatista",
        "hex": "#ac6e85"
      },
      {
        "code": "316",
        "name": "Amarillo oro",
        "hex": "#e9a74e"
      },
      {
        "code": "317",
        "name": "Verde pistacho",
        "hex": "#647843"
      },
      {
        "code": "318",
        "name": "Verde fluorescente",
        "hex": "#83fa81"
      },
      {
        "code": "319",
        "name": "Amarillo fluorescente",
        "hex": "#d3fd8e"
      },
      {
        "code": "320",
        "name": "Fucsia fluorescente",
        "hex": "#fe748e"
      },
      {
        "code": "321",
        "name": "Naranja fluorescente",
        "hex": "#fd766b"
      },
      {
        "code": "322",
        "name": "Chiclets",
        "hex": "#9d1945"
      },
      {
        "code": "323",
        "name": "Verde manzana medio",
        "hex": "#89c66a"
      },
      {
        "code": "324",
        "name": "Verde acadia",
        "hex": "#068d99"
      },
      {
        "code": "400",
        "name": "Amarillo citrico",
        "hex": "#f6b233"
      },
      {
        "code": "401",
        "name": "Amarillo bandera",
        "hex": "#f8b42e"
      },
      {
        "code": "402",
        "name": "Amarillo caterpillar",
        "hex": "#f48e22"
      },
      {
        "code": "403",
        "name": "Mostaza",
        "hex": "#c27a31"
      },
      {
        "code": "404",
        "name": "Azul royal",
        "hex": "#2a3470"
      },
      {
        "code": "405",
        "name": "Azul rey",
        "hex": "#022b7f"
      },
      {
        "code": "406",
        "name": "Turqueza",
        "hex": "#0268aa"
      },
      {
        "code": "407",
        "name": "Aguas profundas",
        "hex": "#034f96"
      },
      {
        "code": "408",
        "name": "Azul petroleo",
        "hex": "#223247"
      },
      {
        "code": "409",
        "name": "Azul marino",
        "hex": "#313445"
      },
      {
        "code": "410",
        "name": "Azul piedra",
        "hex": "#323953"
      },
      {
        "code": "411",
        "name": "Verde benettone",
        "hex": "#02665c"
      },
      {
        "code": "412",
        "name": "Verde menta",
        "hex": "#036e6f"
      },
      {
        "code": "413",
        "name": "Verde botella",
        "hex": "#243f48"
      },
      {
        "code": "414",
        "name": "Verde manzana",
        "hex": "#49b332"
      },
      {
        "code": "415",
        "name": "Verde militar",
        "hex": "#343537"
      },
      {
        "code": "416",
        "name": "Vinotinto",
        "hex": "#54202f"
      },
      {
        "code": "417",
        "name": "Rojo",
        "hex": "#991427"
      },
      {
        "code": "418",
        "name": "Fucsia",
        "hex": "#a10d42"
      },
      {
        "code": "419",
        "name": "Ladrillo",
        "hex": "#b83226"
      },
      {
        "code": "420",
        "name": "Naranja",
        "hex": "#c73f0c"
      },
      {
        "code": "421",
        "name": "Melange",
        "hex": "#6f7387"
      },
      {
        "code": "422",
        "name": "Gris plomo",
        "hex": "#383a51"
      },
      {
        "code": "423",
        "name": "Gris raton",
        "hex": "#313541"
      },
      {
        "code": "424",
        "name": "Negro",
        "hex": "#262b32"
      },
      {
        "code": "425",
        "name": "Chocolate",
        "hex": "#3e2924"
      },
      {
        "code": "426",
        "name": "Avellana",
        "hex": "#7f4b36"
      },
      {
        "code": "427",
        "name": "Cimarron",
        "hex": "#5e3926"
      },
      {
        "code": "428",
        "name": "Amarillo mostaza",
        "hex": "#fbb962"
      },
      {
        "code": "429",
        "name": "Terracota",
        "hex": "#8f4539"
      },
      {
        "code": "430",
        "name": "Coral",
        "hex": "#d4414e"
      },
      {
        "code": "431",
        "name": "Cidra",
        "hex": "#868644"
      },
      {
        "code": "432",
        "name": "Tabaco",
        "hex": "#343031"
      },
      {
        "code": "433",
        "name": "Verde charllot",
        "hex": "#04637c"
      },
      {
        "code": "434",
        "name": "Nazareno",
        "hex": "#2a1e44"
      },
      {
        "code": "435",
        "name": "Naranja fuego",
        "hex": "#c34129"
      },
      {
        "code": "436",
        "name": "Rojo cayena",
        "hex": "#c0393b"
      },
      {
        "code": "437",
        "name": "Verde loro",
        "hex": "#057b6a"
      },
      {
        "code": "438",
        "name": "Gris oscuro",
        "hex": "#212130"
      },
      {
        "code": "439",
        "name": "Pink",
        "hex": "#d94b71"
      },
      {
        "code": "440",
        "name": "Rojo manzana",
        "hex": "#720226"
      },
      {
        "code": "441",
        "name": "Menta oscuro",
        "hex": "#045973"
      },
      {
        "code": "442",
        "name": "Chili red",
        "hex": "#690b20"
      },
      {
        "code": "443",
        "name": "Verde esmeralda",
        "hex": "#067e7e"
      },
      {
        "code": "444",
        "name": "Azul principe",
        "hex": "#043f87"
      },
      {
        "code": "445",
        "name": "Negro chocolate",
        "hex": "#111226"
      },
      {
        "code": "446",
        "name": "Chile papa",
        "hex": "#7e3d35"
      },
      {
        "code": "447",
        "name": "Azul zafiro",
        "hex": "#021c41"
      },
      {
        "code": "448",
        "name": "Verde forest",
        "hex": "#012731"
      },
      {
        "code": "449",
        "name": "Azul noche",
        "hex": "#092037"
      }
    ],
    "notes": "Transcrito de fotos de la carta física (docs/carta de colores.pdf, 2026-08-15). Etiquetas parcialmente cortadas en la foto — confirmar con el cliente: 444 «Azul principe», 446 «Chile papa», 448 «Verde forest», 449 «Azul noche». MELANGE (421) lleva código de oscuro pero la lista de precios lo agrupa con los medios («MEDIOS Y MELANGE»). Hex por color muestreado de las fotos de la carta (mediana del cuerpo de cada franela, 2026-08-15); 100 Blanco neutralizado a casi-blanco por el tinte de la foto. OJO: en la carta física la franela sobre «314 ORO» es AZUL — posible etiqueta corrida, confirmar con el cliente.",
    "source": "carta de colores.pdf",
    "lastUpdate": "2026-08-15T22:00:00.000Z"
  },
  {
    "_id": "config:catalog",
    "type": "config",
    "note": "Catálogo cerrado de telas y grosores (cliente, 2026-08-15: «ya tiene todas las telas, colores y NM's»). counts vacío = grosor libre (sin dato). productType sugiere la categoría al ingresar. Fuente: tablas NM/Dtex de las notas del cliente + lista de precios junio 2026. compositions = mezclas de fibra estándar (cliente): únicas opciones al ingresar; el campo sigue siendo opcional. Pendiente confirmar si el poliéster texturizado (Dtex) necesita «100% poliéster» como cuarta opción.",
    "fabrics": [
      {
        "name": "Jersey",
        "productType": "ROLL",
        "counts": [
          "18/1",
          "20/1",
          "24/1",
          "30/1"
        ]
      },
      {
        "name": "Piqué",
        "productType": "ROLL",
        "counts": [
          "18/1",
          "20/1",
          "24/1",
          "30/1"
        ]
      },
      {
        "name": "Fleece",
        "productType": "ROLL",
        "counts": [
          "18/1",
          "20/1",
          "24/1"
        ]
      },
      {
        "name": "Ribb",
        "productType": "ROLL",
        "counts": [
          "20/1",
          "24/1",
          "30/1"
        ]
      },
      {
        "name": "Interlock",
        "productType": "ROLL",
        "counts": [
          "30/1",
          "40/1"
        ]
      },
      {
        "name": "Cottonlycra",
        "productType": "ROLL",
        "counts": [
          "18/1",
          "20/1",
          "24/1"
        ]
      },
      {
        "name": "Combo",
        "productType": "COMBO",
        "counts": [
          "18/1",
          "20/1",
          "24/1"
        ]
      },
      {
        "name": "Unipolo",
        "productType": "ROLL",
        "counts": [
          "150/1"
        ]
      },
      {
        "name": "Superpolo",
        "productType": "ROLL",
        "counts": [
          "150/1"
        ]
      },
      {
        "name": "Galleta",
        "productType": "ROLL",
        "counts": [
          "150/1"
        ]
      },
      {
        "name": "Atlética",
        "productType": "ROLL",
        "counts": [
          "150/1"
        ]
      },
      {
        "name": "Dry fit",
        "productType": "ROLL",
        "counts": [
          "100/1",
          "75/1"
        ]
      },
      {
        "name": "Poly Lycra",
        "productType": "ROLL",
        "counts": [
          "100/1",
          "75/1"
        ]
      },
      {
        "name": "Sabina",
        "productType": "ROLL",
        "counts": [
          "75/1"
        ]
      },
      {
        "name": "Muselina",
        "productType": "ROLL",
        "counts": []
      }
    ],
    "source": "docs/fabric-standards.md §3 + LISTA DE PRECIOS JUNIO 2026.pdf",
    "lastUpdate": "2026-08-15T23:00:00.000Z",
    "compositions": [
      "65% poliéster / 35% algodón",
      "48% poliéster / 52% algodón",
      "100% algodón"
    ]
  },
  {
    "_id": "config:pricelist:tiendas",
    "type": "config",
    "listName": "LISTA DE PRECIO TIENDAS",
    "clientType": "tiendas",
    "validFrom": "2026-06",
    "note": "Precios por kg salvo CUELLOS Y PUÑOS (por combo). divisasUsd = pago en divisas; bsAtBcvUsd = pago en bolívares a tasa BCV, importe expresado en USD. comp6535 = 65% poliéster / 35% algodón; algodon100 = 100% algodón. Bandas de tono según la carta de colores: blanco+pasteles (100/2xx), medios+melange (3xx/421), oscuros (4xx).",
    "groups": [
      {
        "group": "JERSEY-RIBB 24/1 Y 20/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 7.3,
              "bsAtBcvUsd": 11.5
            },
            "algodon100": {
              "divisasUsd": 11.0,
              "bsAtBcvUsd": 13.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.1,
              "bsAtBcvUsd": 12.5
            },
            "algodon100": {
              "divisasUsd": 12.0,
              "bsAtBcvUsd": 14.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 9.0,
              "bsAtBcvUsd": 14.5
            },
            "algodon100": {
              "divisasUsd": 13.0,
              "bsAtBcvUsd": 15.0
            }
          }
        ]
      },
      {
        "group": "RIBB 24/1 SOLO",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 7.5,
              "bsAtBcvUsd": 11.7
            },
            "algodon100": {
              "divisasUsd": 11.5,
              "bsAtBcvUsd": 13.5
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.3,
              "bsAtBcvUsd": 12.7
            },
            "algodon100": {
              "divisasUsd": 12.5,
              "bsAtBcvUsd": 14.5
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 9.3,
              "bsAtBcvUsd": 14.7
            },
            "algodon100": {
              "divisasUsd": 13.5,
              "bsAtBcvUsd": 15.5
            }
          }
        ]
      },
      {
        "group": "PIQUET 24/1 Y 20/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 7.3,
              "bsAtBcvUsd": 11.5
            },
            "algodon100": {
              "divisasUsd": 11.0,
              "bsAtBcvUsd": 13.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.1,
              "bsAtBcvUsd": 12.5
            },
            "algodon100": {
              "divisasUsd": 12.0,
              "bsAtBcvUsd": 14.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 9.0,
              "bsAtBcvUsd": 14.5
            },
            "algodon100": {
              "divisasUsd": 13.0,
              "bsAtBcvUsd": 15.0
            }
          }
        ]
      },
      {
        "group": "CUELLOS Y PUÑOS",
        "unit": "combo",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 1.0,
              "bsAtBcvUsd": 1.25
            },
            "algodon100": {
              "divisasUsd": 1.5,
              "bsAtBcvUsd": 2.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 1.0,
              "bsAtBcvUsd": 1.25
            },
            "algodon100": {
              "divisasUsd": 1.5,
              "bsAtBcvUsd": 2.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 1.0,
              "bsAtBcvUsd": 1.25
            },
            "algodon100": {
              "divisasUsd": 1.5,
              "bsAtBcvUsd": 2.0
            }
          }
        ]
      },
      {
        "group": "JERSEY-RIBB 30/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 7.2,
              "bsAtBcvUsd": 11.5
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.1,
              "bsAtBcvUsd": 12.5
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 9.0,
              "bsAtBcvUsd": 14.5
            }
          }
        ]
      },
      {
        "group": "INTERLOCK RIBB 30/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 8.0,
              "bsAtBcvUsd": 12.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.8,
              "bsAtBcvUsd": 13.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 10.0,
              "bsAtBcvUsd": 15.0
            }
          }
        ]
      },
      {
        "group": "FLEECE 24/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 7.8,
              "bsAtBcvUsd": 12.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.4,
              "bsAtBcvUsd": 13.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 9.5,
              "bsAtBcvUsd": 15.0
            }
          }
        ]
      },
      {
        "group": "SABINA-ATLETICA-MUSELINA",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 6.7,
              "bsAtBcvUsd": 10.5
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 7.0,
              "bsAtBcvUsd": 11.5
            }
          }
        ]
      },
      {
        "group": "UNIPOLO PIQUET POLI",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 6.0,
              "bsAtBcvUsd": 9.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 6.3,
              "bsAtBcvUsd": 10.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 7.0,
              "bsAtBcvUsd": 11.0
            }
          }
        ]
      },
      {
        "group": "POLIESTER LICRA 75/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 6.7,
              "bsAtBcvUsd": 10.5
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 7.0,
              "bsAtBcvUsd": 11.5
            }
          }
        ]
      },
      {
        "group": "DRY-FIT",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 6.5,
              "bsAtBcvUsd": 8.5
            },
            "importado": {
              "divisasUsd": 6.5,
              "bsAtBcvUsd": 8.5
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 7.0,
              "bsAtBcvUsd": 9.5
            }
          }
        ]
      },
      {
        "group": "IMPORTADOS",
        "prices": [
          {
            "band": "FLEECE AZUL MARINO",
            "comp6535": {
              "divisasUsd": 6.2,
              "bsAtBcvUsd": 8.0
            }
          },
          {
            "band": "POLYLICRA BLANCA",
            "comp6535": {
              "divisasUsd": 5.5,
              "bsAtBcvUsd": 7.0
            }
          }
        ]
      }
    ],
    "source": "LISTA DE PRECIOS JUNIO 2026.pdf",
    "lastUpdate": "2026-08-15T00:00:00.000Z"
  }
] as const;

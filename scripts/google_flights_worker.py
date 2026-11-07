import sys
import json
import requests
from selectolax.lexbor import LexborHTMLParser
from fast_flights import create_query, Passengers, FlightQuery

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

def search_google_flights(origin, dest, date, seat="business", adults=2, currency="USD", direct_only=True):
    try:
        q = create_query(
            flights=[FlightQuery(date=date, from_airport=origin, to_airport=dest)],
            seat=seat,
            trip="one-way",
            max_stops=0 if direct_only else None,
            passengers=Passengers(adults=int(adults)),
            currency=currency
        )
        url = q.url()
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Cookie": "SOCS=CAISHAgBEhJnd3NfMjAyNDA3MTUtMF9SQzIaAmVuIAEaBgiA_L20Bg; CONSENT=PENDING+999"
        }
        r = requests.get(url, headers=headers, timeout=12)
        if r.status_code != 200:
            return {"success": False, "error": f"HTTP {r.status_code}", "results": []}

        parser = LexborHTMLParser(r.text)
        script = parser.css_first("script.ds\\:1")
        if not script:
            return {"success": False, "error": "script.ds:1 not found (consent or block)", "results": []}

        data_str = script.text().split("data:", 1)[1].rsplit(",", 1)[0]
        payload = json.loads(data_str)
        items = payload[3][0] or []

        results = []
        for k in items:
            flight_data = k[0]
            legs = flight_data[2]
            if direct_only and len(legs) != 1:
                continue

            airline_names = flight_data[1]
            pricing = k[1] if len(k) > 1 else None
            price_total = pricing[0][1] if pricing and len(pricing) > 0 and len(pricing[0]) > 1 else None
            if price_total is None:
                continue # Only include priced results

            leg = legs[0]
            from_code = leg[3]
            to_code = leg[6]
            flight_info = leg[22] if len(leg) > 22 and leg[22] else None
            flight_num = f"{flight_info[0]} {flight_info[1]}" if flight_info and len(flight_info) >= 2 else (leg[1] if len(leg) > 1 else "N/A")
            plane = leg[17] if len(leg) > 17 else "N/A"
            dep_date = tuple(leg[20]) if len(leg) > 20 and leg[20] else None
            dep_time = tuple(leg[8]) if len(leg) > 8 and leg[8] else None

            dep_date_str = f"{dep_date[0]:04d}-{dep_date[1]:02d}-{dep_date[2]:02d}" if dep_date and len(dep_date) >= 3 else date
            minute = dep_time[1] if dep_time and len(dep_time) > 1 else 0
            hour = dep_time[0] if dep_time and len(dep_time) > 0 else 0
            dep_time_str = f"{hour:02d}:{minute:02d}:00"

            results.append({
                "origin": from_code,
                "destination": to_code,
                "departureDate": dep_date_str,
                "departureTime": dep_time_str,
                "departureIso": f"{dep_date_str}T{dep_time_str}",
                "airline": airline_names[0] if airline_names else "Авиакомпания",
                "flightNumber": flight_num,
                "gate": "Google Flights / Официальный перевозчик",
                "plane": plane,
                "transfers": len(legs) - 1,
                "cabinClass": seat,
                "pricePerPassenger": round(price_total / int(adults)),
                "priceTotal": price_total,
                "currency": currency,
                "foundAt": dep_date_str + "T" + dep_time_str,
                "isActual": True,
                "deepLink": url
            })

        return {"success": True, "results": results}
    except Exception as e:
        return {"success": False, "error": str(e), "results": []}

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(json.dumps({"success": False, "error": "Missing arguments", "results": []}))
        sys.exit(1)

    orig = sys.argv[1]
    dest = sys.argv[2]
    d = sys.argv[3]
    seat = sys.argv[4] if len(sys.argv) > 4 else "business"
    pax = int(sys.argv[5]) if len(sys.argv) > 5 else 2
    curr = sys.argv[6] if len(sys.argv) > 6 else "USD"
    direct = sys.argv[7].lower() == "true" if len(sys.argv) > 7 else True

    res = search_google_flights(orig, dest, d, seat, pax, curr, direct)
    print(json.dumps(res, ensure_ascii=False))

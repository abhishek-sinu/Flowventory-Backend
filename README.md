# DMS-BACKEND

## How to Start the Backend

1. Open a terminal and navigate to the `DMS-BACKEND` directory:
	```sh
	cd DMS-BACKEND
	```
2. Install npm from website & dependencies by command:
	```sh
	npm install
	```
3. Put .env file with db details in root directory and start the backend server:
	```sh
	npm start
	```
4. The backend will run on the port specified in your configuration (commonly 3001 or as set in your code).

---



# DMS-DATABASE

## How to Start the database

1. Install mysql database server(GUI) and connect using connection details.
2. Access sql code from database_sql folder and run all of them to have all the tables in local mysql server.
3. Put .env file with db details in root directory and start the backend server:
	```sh
	npm start
	```
4. The backend will run on the port specified in your configuration (5000). _Append_ 'api/donors' in url to see donors data from your local database.

5. To fill dummy data in gifts table - 
INSERT INTO gifts (phone, gift_name, description, value, date_given, created_at)
VALUES
('9876543210', 'Bhagavad Gita', 'Spiritual book', 250.00, '2026-01-10', NOW()),
('9123456780', 'Tulsi Mala', 'Sacred chanting beads', 150.00, '2026-01-12', NOW()),
('9988776655', 'Krishna Idol', 'Small marble idol', 1200.00, '2026-01-15', NOW()),
('9012345678', 'Incense Pack', 'Agarbatti set', 100.00, '2026-01-18', NOW()),
('9090909090', 'Bhajan CD', 'Devotional songs collection', 200.00, '2026-01-20', NOW()),
('8888888888', 'Spiritual Calendar', 'ISKCON calendar', 80.00, '2026-01-22', NOW()),
('9777777777', 'Prasadam Box', 'Sanctified food pack', 300.00, '2026-01-25', NOW()),
('9666666666', 'Chanting Counter', 'Digital tally counter', 180.00, '2026-01-27', NOW()),
('9555555555', 'Wall Poster', 'Radha Krishna poster', 120.00, '2026-01-29', NOW()),
('9444444444', 'Donation Receipt Book', 'Receipt booklet', 500.00, '2026-02-01', NOW());
---


# New route addition

## How to add new route

1. Make new file in routes folder and add your file_name.js file.
2. Update server.js file to include your new route details.
3. 


---